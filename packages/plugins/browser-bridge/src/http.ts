/* oxlint-disable executor/no-try-catch-or-throw, executor/no-unknown-error-message -- boundary: this Fetch adapter converts untyped request and long-poll failures into generic HTTP responses */

/**
 * HTTP surface for Executor Browser extension reverse channel.
 *
 *   POST   /api/browser-bridge/session
 *   GET    /api/browser-bridge/session/:id/jobs?waitMs=
 *   POST   /api/browser-bridge/session/:id/result
 *   DELETE /api/browser-bridge/session/:id
 *   GET    /api/browser-bridge/sessions
 */

import {
  createSession,
  deleteSession,
  getSession,
  listSessionsForUser,
  postResult,
  sessionPublicView,
  takeJobs,
  updateSessionCapabilities,
} from "./store";

export type AuthSession = {
  user: { id: string; name?: string | null; email?: string | null };
  session?: { activeOrganizationId?: string | null };
};

export type BrowserBridgeHttpDeps = {
  /** Resolve Bearer / API key / cookie session. Return null if unauthenticated. */
  readonly getSession: (request: Request) => Promise<AuthSession | null>;
  /**
   * After a reverse session opens, provision the visible Chrome integration +
   * connection in the Executor catalog (so the site shows "Chrome / desktop").
   * Best-effort, must not fail the session open.
   */
  readonly ensureCatalog?: (request: Request) => Promise<{
    ok: boolean;
    detail?: string;
  }>;
};

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

const unauthorized = (error = "unauthorized") => json({ error }, 401);

/**
 * The bridge is a machine surface, not a page.
 *
 * The extension always dials out with an API key, so requiring that credential
 * explicitly costs it nothing, and it keeps any page the user happens to have
 * open from reaching these routes on the strength of an ambient cookie. That
 * matters most for `POST /session/:id/result` and `PATCH /session/:id`, which
 * inject tool results and the advertised access scope.
 *
 * Presence alone is not the test. An identity resolver that falls back to the
 * cookie when a bearer value does not resolve would let `Authorization: Bearer
 * anything` re-open the door, so the cookie is *removed* before the request is
 * handed on: the presented credential is then the only thing that can
 * authenticate, whatever the resolver would otherwise have accepted.
 */
function hasPresentedCredential(request: Request): boolean {
  return Boolean(
    request.headers.get("authorization")?.trim() || request.headers.get("x-api-key")?.trim(),
  );
}

function withoutAmbientCookie(request: Request): Request {
  if (!request.headers.has("cookie")) return request;
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  return new Request(request, { headers });
}
const notFound = (msg = "not found") => json({ error: msg }, 404);
const badRequest = (msg: string) => json({ error: msg }, 400);

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * Mount at `/api/browser-bridge/*` (and exact `/api/browser-bridge`).
 */
export function makeBrowserBridgeHandler(deps: BrowserBridgeHttpDeps) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    // Normalize path: strip /api/browser-bridge prefix
    let path = url.pathname;
    const markers = ["/api/browser-bridge", "/browser-bridge"];
    for (const m of markers) {
      if (path === m || path.startsWith(m + "/")) {
        path = path.slice(m.length) || "/";
        break;
      }
    }

    if (!hasPresentedCredential(request)) {
      return unauthorized(
        "browser bridge requires an API key (Authorization: Bearer … or x-api-key); a browser session cookie is not accepted",
      );
    }
    const auth = await deps.getSession(withoutAmbientCookie(request));
    if (!auth?.user?.id) return unauthorized();
    const userId = auth.user.id;
    const organizationId = auth.session?.activeOrganizationId || undefined;

    // POST /session, open reverse channel + ensure catalog shows Chrome
    if (path === "/session" && request.method === "POST") {
      const body = (await readJson(request)) as Record<string, unknown> | null;
      const session = createSession({
        userId,
        organizationId,
        kind: typeof body?.kind === "string" ? body.kind : "chrome-extension",
        transport: typeof body?.transport === "string" ? body.transport : "reverse-longpoll",
        client: (body?.client as Record<string, unknown>) || undefined,
        capabilities: body?.capabilities,
        connection: (body?.connection as Record<string, unknown>) || undefined,
      });

      let catalog: { ok: boolean; detail?: string } | undefined;
      if (deps.ensureCatalog) {
        try {
          catalog = await deps.ensureCatalog(request);
        } catch (e) {
          catalog = { ok: false, detail: String(e) };
        }
      }

      return json({
        ...sessionPublicView(session),
        id: session.id,
        pollPath: `/api/browser-bridge/session/${session.id}/jobs`,
        resultPath: `/api/browser-bridge/session/${session.id}/result`,
        // What should appear in Executor UI after this
        integration: "browser",
        connection: "desktop",
        address: "tools.browser.user.desktop",
        catalog,
      });
    }

    // POST /install, re-run catalog ensure without a new session
    if (path === "/install" && request.method === "POST") {
      if (!deps.ensureCatalog) {
        return json({ ok: false, error: "catalog ensure not wired on this host" }, 501);
      }
      try {
        const catalog = await deps.ensureCatalog(request);
        return json({
          ...catalog,
          integration: "browser",
          connection: "desktop",
          address: "tools.browser.user.desktop",
        });
      } catch (e) {
        return json({ ok: false, error: String(e) }, 500);
      }
    }

    // GET /sessions
    if (path === "/sessions" && request.method === "GET") {
      return json({
        sessions: listSessionsForUser(userId).map(sessionPublicView),
      });
    }

    // /session/:id/...
    const sessionMatch = path.match(/^\/session\/([^/]+)(?:\/(jobs|result))?$/);
    if (sessionMatch) {
      const sessionId = decodeURIComponent(sessionMatch[1]!);
      const sub = sessionMatch[2];

      if (!sub && request.method === "DELETE") {
        const ok = deleteSession(sessionId, userId);
        return ok ? json({ ok: true }) : notFound("session not found");
      }

      if (!sub && request.method === "GET") {
        const s = getSession(sessionId);
        if (!s || s.userId !== userId) return notFound("session not found");
        return json(sessionPublicView(s));
      }

      // Re-advertise capabilities without reopening the channel, so a change to
      // access mode or the control session is visible immediately.
      if (!sub && request.method === "PATCH") {
        const body = (await readJson(request)) as { capabilities?: unknown } | null;
        if (body?.capabilities === undefined) return badRequest("capabilities required");
        const ok = updateSessionCapabilities(sessionId, userId, body.capabilities);
        return ok ? json({ ok: true }) : notFound("session not found");
      }

      if (sub === "jobs" && request.method === "GET") {
        const waitMs = Number(url.searchParams.get("waitMs") || "25000");
        try {
          const jobs = await takeJobs(sessionId, userId, waitMs);
          return json({ jobs });
        } catch (e) {
          return notFound(String(e));
        }
      }

      if (sub === "result" && request.method === "POST") {
        const body = (await readJson(request)) as {
          jobId?: string;
          result?: unknown;
        } | null;
        if (!body?.jobId) return badRequest("jobId required");
        const ok = postResult(sessionId, userId, body.jobId, body.result);
        return ok ? json({ ok: true }) : notFound("job not found");
      }
    }

    return notFound(`unknown browser-bridge path ${path}`);
  };
}
