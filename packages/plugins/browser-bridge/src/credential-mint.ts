/* oxlint-disable executor/no-try-catch-or-throw, executor/no-promise-catch, executor/no-instanceof-error, executor/no-unknown-error-message -- boundary: this is the fetch adapter for Cloudflare's token API; it converts network and HTTP failures into the typed MintOutcome that callers consume */

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
