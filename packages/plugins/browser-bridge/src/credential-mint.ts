/* oxlint-disable executor/no-try-catch-or-throw, executor/no-promise-catch, executor/no-instanceof-error, executor/no-unknown-error-message, executor/no-json-parse -- boundary: this is the adapter for Cloudflare's token API and for MCP tool results; it converts network, HTTP, and untyped MCP content into the typed MintOutcome that callers consume, and an MCP text block is arbitrary text that has to be probed rather than decoded */

/**
 * Mint a browser credential from one the user already has.
 *
 * Most people who want a Cloudflare browser already hold a Cloudflare
 * credential here, typically an MCP connection with broad access. That
 * credential cannot be copied into a browser target: an OAuth access token is
 * not an API token and expires besides. But it can often *create* the API
 * token, which turns "go to the dashboard, find the right one of forty
 * permissions, paste it back" into one button.
 *
 * Two rules govern everything here.
 *
 * Nothing is minted without an explicit request. Creating an API token on
 * someone's account is a real, lasting side effect on infrastructure this
 * plugin does not own, so it happens only when a user asks for it by name,
 * never as a fallback when another path failed.
 *
 * The token is scoped to exactly what a browser needs: Browser Rendering on one
 * account, and nothing else. The credential doing the minting is usually far
 * broader; inheriting that breadth would quietly turn a browser target into the
 * most powerful credential in the catalog.
 */

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/**
 * The same mint, run inside the provider's own MCP server.
 *
 * An MCP connection's stored credential authenticates to the MCP *server*, not
 * to `api.cloudflare.com`, so using it as a bearer against the REST API fails
 * at the first call with "cannot read the permission list". The account's real
 * authority lives behind the MCP server, reachable only by calling its tools.
 *
 * Cloudflare's MCP server exposes `execute`, which runs a JavaScript arrow
 * function against the Cloudflare API using the grant the user already
 * approved. So the minting logic moves into that function rather than being
 * denied the credential to run it here.
 *
 * The code is a single self-contained expression on purpose: it is a string
 * crossing a tool boundary, and anything it needs from this process has to be
 * interpolated in. Only an account ID and a label are, both non-secret.
 */
export function cloudflareMintScript(options: {
  readonly accountId: string;
  readonly label: string;
}): string {
  // Cloudflare's `execute` tool pre-binds `accountId` to the account its grant
  // covers. When the user named no account, that binding is the right answer,
  // and referencing the identifier is how the script asks for it. Falling back
  // to an empty string would build the policy resource
  // `com.cloudflare.api.account.` and mint a token scoped to nothing.
  const account = options.accountId ? JSON.stringify(options.accountId) : "accountId";
  const label = JSON.stringify(options.label);
  return `async () => {
  const account = ${account};
  const attempts = [];
  const tryRequest = async (options) => {
    try {
      const response = await cloudflare.request(options);
      attempts.push(options.method + " " + options.path + " -> " + response.status);
      return response;
    } catch (error) {
      attempts.push(options.method + " " + options.path + " threw " + String(error && error.message || error));
      return null;
    }
  };

  // Cloudflare owns API tokens at two scopes. An account-scoped MCP grant can
  // usually reach the account route and not the user route, so both are tried
  // rather than assuming which one this grant covers.
  const groupRoutes = [
    "/accounts/" + account + "/tokens/permission_groups",
    "/user/tokens/permission_groups",
  ];
  let group = null;
  let seen = [];
  // Tracked separately from the group search: an empty list because the route
  // was refused is not evidence the account lacks Browser Rendering, and
  // reporting it as such sends someone to check a plan that is fine.
  let readAny = false;
  let total = 0;
  for (const path of groupRoutes) {
    const response = await tryRequest({ method: "GET", path, query: { per_page: 200 } });
    const all = response && Array.isArray(response.result) ? response.result : [];
    if (all.length) { readAny = true; total += all.length; }
    // Widened from "browser rendering": Cloudflare names these groups itself
    // and a near miss ("Workers Browser Rendering") would otherwise read as an
    // account without the capability.
    const browser = all.filter((g) => /browser|render/i.test(String(g && g.name)));
    if (browser.length) seen = browser.map((g) => g.name);
    const writable = browser.find(
      (g) => /render/i.test(String(g.name)) && /edit|write/i.test(String(g.name)),
    );
    if (writable) { group = writable; break; }
  }
  if (!group) {
    return {
      minted: false,
      reason: !readAny ? "unreadable" : seen.length ? "read-only" : "unavailable",
      seen, total, attempts,
    };
  }

  const body = {
    name: ${label},
    policies: [{
      effect: "allow",
      resources: { ["com.cloudflare.api.account." + account]: "*" },
      permission_groups: [{ id: group.id }],
    }],
  };
  for (const path of ["/accounts/" + account + "/tokens", "/user/tokens"]) {
    const created = await tryRequest({ method: "POST", path, body });
    if (created && created.success && created.result && created.result.value) {
      return { minted: true, token: created.result.value, permission: group.name,
               accountId: account, attempts };
    }
    if (created && created.errors && created.errors.length) {
      seen = created.errors;
    }
  }
  return { minted: false, reason: "rejected", errors: seen, permission: group.name, attempts };
}`;
}

/** Whatever the MCP tool returned, reduced to the shape this module needs. */
export function readMintScriptResult(raw: unknown): MintOutcome {
  const found = findMintPayload(raw);
  if (!found) {
    // Quoting what actually came back, rather than only saying it could not be
    // read. An MCP server can answer with an error envelope, a formatted
    // string, or JSON inside a code fence, and "could not read" leaves the
    // person holding it with nothing to act on and nothing to report.
    const excerpt = textFromResult(raw);
    return {
      ok: false,
      reason: isErrorResult(raw) ? "permission" : "provider",
      detail: excerpt
        ? `Cloudflare MCP said: ${excerpt}`
        : "The Cloudflare MCP server returned a result this could not read",
    };
  }
  if (found.minted === true && typeof found.token === "string" && found.token) {
    return {
      ok: true,
      token: found.token,
      detail: `Created a Cloudflare token scoped to ${String(found.permission || "Browser Rendering")} on this account`,
    };
  }
  // The routes it tried, with their statuses. Cloudflare owns API tokens at two
  // scopes and a grant may reach one and not the other, so any failure here is
  // only actionable alongside which endpoint answered what. Appended to every
  // branch, not just the last: the earlier ones are the likelier to be wrong.
  const attempts = Array.isArray(found.attempts)
    ? found.attempts.filter((entry): entry is string => typeof entry === "string").join(", ")
    : "";
  const withAttempts = (text: string) => (attempts ? `${text} (tried ${attempts})` : text);

  if (found.reason === "unreadable") {
    return {
      ok: false,
      reason: "permission",
      detail: withAttempts(
        "Could not read Cloudflare's permission list through this MCP connection, so no token was created.",
      ),
    };
  }
  if (found.reason === "unavailable" || found.reason === "read-only") {
    const seen = Array.isArray(found.seen)
      ? found.seen.filter((entry): entry is string => typeof entry === "string")
      : [];
    const total = typeof found.total === "number" ? found.total : 0;
    return {
      ok: false,
      reason: "not-found",
      detail: withAttempts(
        found.reason === "read-only"
          ? `Cloudflare offers no writable Browser Rendering permission here. Found: ${seen.join(", ")}.`
          : `No Browser Rendering permission exists on this Cloudflare account. Read ${total} permission groups, none matching.`,
      ),
    };
  }
  const errors = Array.isArray(found.errors)
    ? found.errors
        .map((entry) =>
          typeof entry === "string" ? entry : (entry as { message?: unknown })?.message,
        )
        .filter((message): message is string => typeof message === "string")
        .join("; ")
    : "";
  const base =
    errors ||
    "Cloudflare refused to create the token. The MCP connection may not carry the API Tokens Write permission.";
  return { ok: false, reason: "permission", detail: withAttempts(base) };
}

type MintPayload = {
  minted?: unknown;
  token?: unknown;
  reason?: unknown;
  permission?: unknown;
  errors?: unknown;
  attempts?: unknown;
  seen?: unknown;
  total?: unknown;
};

/**
 * MCP results arrive in more than one shape: a structured object, or content
 * blocks carrying JSON as text. Both are searched rather than assuming one,
 * because guessing wrong here reads as "the mint failed" when it succeeded and
 * would leave a real token created on the account with nothing holding it.
 */
function findMintPayload(raw: unknown): MintPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if ("minted" in record) return record as MintPayload;

  for (const key of ["structuredContent", "result", "output", "value", "data"]) {
    const nested = findMintPayload(record[key]);
    if (nested) return nested;
  }
  const content = record.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const text = (block as { text?: unknown })?.text;
      if (typeof text !== "string") continue;
      for (const candidate of jsonObjectsIn(text)) {
        const nested = findMintPayload(candidate);
        if (nested) return nested;
      }
    }
  }
  return null;
}

/**
 * Every JSON object embedded in a block of text, outermost first.
 *
 * MCP servers return the same value as bare JSON, as JSON inside a markdown
 * fence, and as JSON with a sentence in front of it. Parsing the whole string
 * handles only the first, so the braces are scanned instead.
 */
function jsonObjectsIn(text: string): Record<string, unknown>[] {
  const trimmed = text.trim();
  const found: Record<string, unknown>[] = [];
  const whole = parseJsonObject(trimmed);
  if (whole) found.push(whole);

  for (let start = trimmed.indexOf("{"); start !== -1; start = trimmed.indexOf("{", start + 1)) {
    // Longest match first: an outer object carrying the payload beats an inner
    // fragment that happens to parse on its own.
    for (let end = trimmed.lastIndexOf("}"); end > start; end = trimmed.lastIndexOf("}", end - 1)) {
      const parsed = parseJsonObject(trimmed.slice(start, end + 1));
      if (parsed) {
        found.push(parsed);
        break;
      }
    }
    if (found.length > 4) break;
  }
  return found;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The MCP execution-error envelope: the call ran and the tool reported failure. */
function isErrorResult(raw: unknown): boolean {
  return Boolean(raw && typeof raw === "object" && (raw as { isError?: unknown }).isError === true);
}

/** A short, readable excerpt of whatever the server sent, for an error message. */
function textFromResult(raw: unknown): string {
  if (typeof raw === "string") return clip(raw);
  if (!raw || typeof raw !== "object") return "";
  const content = (raw as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const text = content
      .map((block) => (block as { text?: unknown })?.text)
      .filter((value): value is string => typeof value === "string")
      .join(" ")
      .trim();
    if (text) return clip(text);
  }
  return "";
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}...` : flat;
}

export type MintDeps = {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  /** Injected so a test does not depend on the clock for the token's name. */
  readonly now?: () => number;
};

export type MintOutcome =
  | { readonly ok: true; readonly token: string; readonly detail: string }
  | { readonly ok: false; readonly reason: MintFailureReason; readonly detail: string };

export type MintFailureReason = "permission" | "unsupported" | "network" | "provider" | "not-found";

const DEFAULT_TIMEOUT_MS = 10_000;

async function apiJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; body: Record<string, unknown> } | { networkError: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: response.status, body };
  } catch (error) {
    return { networkError: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The permission group that lets a token drive Browser Rendering.
 *
 * Looked up rather than hardcoded: permission group IDs are account-visible
 * UUIDs that Cloudflare owns, and a stale constant would mint a token with no
 * permissions at all, which fails later as an unexplained 403.
 */
export async function cloudflareBrowserPermissionGroup(
  token: string,
  deps: MintDeps = {},
): Promise<{ id: string; name: string } | { reason: MintFailureReason; detail: string }> {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const groups = await apiJson(
    fetchImpl,
    `${CLOUDFLARE_API}/user/tokens/permission_groups`,
    { method: "GET", headers: { authorization: `Bearer ${token}` } },
    timeoutMs,
  );
  if ("networkError" in groups) {
    return { reason: "network", detail: `Could not reach Cloudflare: ${groups.networkError}` };
  }
  if (groups.status === 401 || groups.status === 403) {
    return {
      reason: "permission",
      detail: "This credential cannot read Cloudflare's permission list",
    };
  }
  if (groups.status >= 400) {
    return { reason: "provider", detail: `Cloudflare returned ${groups.status}` };
  }

  const result = Array.isArray(groups.body.result) ? groups.body.result : [];
  const named = result
    .map((entry) => entry as { id?: unknown; name?: unknown })
    .filter(
      (entry): entry is { id: string; name: string } =>
        typeof entry.id === "string" && typeof entry.name === "string",
    )
    .filter((entry) => /browser rendering/i.test(entry.name));
  // "Edit" and "Write" are the same idea under two names across Cloudflare's
  // own surfaces, and a read-only group cannot start a browser, so the writable
  // one is required rather than merely preferred.
  const writable = named.find((entry) => /edit|write/i.test(entry.name));
  if (!writable) {
    return {
      reason: "not-found",
      detail: named.length
        ? "Cloudflare offers no writable Browser Rendering permission for this account"
        : "Browser Rendering is not available on this Cloudflare account",
    };
  }
  return writable;
}

/**
 * Create a Browser Rendering API token on one Cloudflare account.
 *
 * @param options.token The existing credential doing the minting. Never stored,
 *   never returned, and only ever the one the user pointed at.
 */
export async function mintCloudflareBrowserToken(
  options: { readonly token: string; readonly accountId: string; readonly label?: string },
  deps: MintDeps = {},
): Promise<MintOutcome> {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const group = await cloudflareBrowserPermissionGroup(options.token, deps);
  if ("reason" in group) return { ok: false, reason: group.reason, detail: group.detail };

  const stamp = new Date(deps.now?.() ?? Date.now()).toISOString().slice(0, 10);
  const created = await apiJson(
    fetchImpl,
    `${CLOUDFLARE_API}/user/tokens`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: `${options.label || "Executor browser"} ${stamp}`.slice(0, 120),
        policies: [
          {
            effect: "allow",
            // Scoped to this one account, so the token cannot reach anything
            // else the minting credential happens to have access to.
            resources: { [`com.cloudflare.api.account.${options.accountId}`]: "*" },
            permission_groups: [{ id: group.id }],
          },
        ],
      }),
    },
    timeoutMs,
  );
  if ("networkError" in created) {
    return {
      ok: false,
      reason: "network",
      detail: `Could not reach Cloudflare: ${created.networkError}`,
    };
  }
  if (created.status === 401 || created.status === 403) {
    return {
      ok: false,
      reason: "permission",
      detail:
        "This credential is not allowed to create API tokens. Grant it the API Tokens Write permission, or paste a Browser Rendering token instead.",
    };
  }
  if (created.status >= 400) {
    return { ok: false, reason: "provider", detail: `Cloudflare returned ${created.status}` };
  }

  const value = (created.body.result as { value?: unknown } | undefined)?.value;
  if (typeof value !== "string" || !value) {
    // Cloudflare returns the secret exactly once, at creation. If it is not in
    // this response it cannot be fetched later, so the token is unusable and
    // saying so beats storing an empty credential.
    return {
      ok: false,
      reason: "provider",
      detail: "Cloudflare created a token but did not return its value",
    };
  }
  return {
    ok: true,
    token: value,
    detail: `Created a Cloudflare token scoped to ${group.name} on this account`,
  };
}
