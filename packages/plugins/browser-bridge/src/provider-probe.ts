/* oxlint-disable executor/no-try-catch-or-throw, executor/no-promise-catch, executor/no-instanceof-error, executor/no-unknown-error-message, executor/no-switch-statement -- boundary: this is the fetch adapter for third-party provider APIs; it converts network and HTTP failures into the typed ProviderProbe result that callers consume */

/**
 * Credential probes for remote browser providers.
 *
 * Health for a remote target used to be reported as `healthy` unconditionally,
 * so a revoked token or a missing permission looked identical to a working
 * setup. Every probe here answers three separate questions, can we reach the
 * provider, is the credential accepted, and does it carry the permission the
 * browser target actually needs, because the remedy differs for each.
 *
 * Probes are deliberately cheap and non-billing: none of them starts a browser.
 */

export type ProbeFailureReason =
  /** Endpoint unreachable, DNS failure, TLS error, timeout. */
  | "network"
  /** Credential rejected outright (401). */
  | "auth"
  /** Credential valid but lacks the permission this target needs (403). */
  | "permission"
  /** Stored configuration is unusable without contacting the provider. */
  | "config"
  /** Host-side prerequisite is absent (e.g. no ambient Vercel identity). */
  | "host";

export type ProviderProbe =
  | {
      readonly ok: true;
      readonly detail: string;
      /**
       * True when the credential was accepted but the specific permission
       * could not be confirmed. Reported honestly rather than as a pass.
       */
      readonly permissionVerified: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: ProbeFailureReason;
      readonly detail: string;
      /** One actionable sentence. Shown verbatim in the UI. */
      readonly hint: string;
    };

export type ProbeDeps = {
  readonly fetch?: typeof globalThis.fetch;
  readonly env?: Record<string, string | undefined>;
  readonly timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 8_000;

const CLOUDFLARE_TOKEN_HINT =
  "Create a token with the Browser Rendering permission at " +
  "https://dash.cloudflare.com/profile/api-tokens, then paste it here.";

async function requestJson(
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
    const message =
      error instanceof Error && error.name === "AbortError"
        ? `No response within ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error);
    return { networkError: message };
  } finally {
    clearTimeout(timer);
  }
}

const unreachable = (detail: string, what: string): ProviderProbe => ({
  ok: false,
  reason: "network",
  detail,
  hint: `Could not reach ${what}. Check this Executor host's outbound network access.`,
});

/**
 * The account a Cloudflare token belongs to, when there is only one.
 *
 * Asking for an account ID made a second field mandatory to reach a browser
 * when the token already names its own account: `/accounts` is readable by any
 * token, so the common case (one account) needs no input at all.
 *
 * Returns null rather than guessing when the token spans several accounts.
 * Picking the first would silently point the browser at the wrong one, and a
 * wrong ID fails later as a 403 that reads like a bad token.
 */
export async function inferCloudflareAccountId(
  token: string,
  deps: ProbeDeps = {},
): Promise<{ accountId: string } | { reason: "none" | "ambiguous" | "unreadable" }> {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const accounts = await requestJson(
    fetchImpl,
    "https://api.cloudflare.com/client/v4/accounts?per_page=50",
    { method: "GET", headers: { authorization: `Bearer ${token}` } },
    timeoutMs,
  );
  if ("networkError" in accounts || accounts.status >= 400) return { reason: "unreadable" };
  const result = (accounts.body as { result?: unknown })?.result;
  const ids = Array.isArray(result)
    ? result
        .map((entry) => (entry as { id?: unknown })?.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  if (ids.length === 0) return { reason: "none" };
  if (ids.length > 1) return { reason: "ambiguous" };
  return { accountId: ids[0]! };
}

async function probeCloudflare(
  accountId: string,
  token: string | null,
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<ProviderProbe> {
  if (!token) {
    return {
      ok: false,
      reason: "config",
      detail: "No API token is stored for this target",
      hint: CLOUDFLARE_TOKEN_HINT,
    };
  }
  const headers = { authorization: `Bearer ${token}` };

  // The browser endpoint is the check, rather than a generic token-validity
  // call, because it is the only one every token that should pass here can
  // answer. Cloudflare issues API tokens at user scope and at account scope,
  // and /user/tokens/verify rejects an account-scoped token with a 401 that is
  // indistinguishable from a revoked credential. A token minted for this
  // plugin is account-scoped, so validating it that way called every good
  // token invalid. Reading /accounts/{id} to prove scope has the same flaw
  // from the other side: a token holding Browser Rendering alone has no
  // Account Settings Read and answers 403.
  const limits = await requestJson(
    fetchImpl,
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/browser-rendering/limits`,
    { method: "GET", headers },
    timeoutMs,
  );
  if ("networkError" in limits) return unreachable(limits.networkError, "the Cloudflare API");
  if (limits.status < 400) {
    return {
      ok: true,
      detail: "Token valid; Browser Rendering permission confirmed",
      permissionVerified: true,
    };
  }
  if (limits.status === 401) {
    return {
      ok: false,
      reason: "auth",
      detail: "Cloudflare rejected the API token (401)",
      hint: "The token is invalid, expired, or revoked. " + CLOUDFLARE_TOKEN_HINT,
    };
  }
  if (limits.status === 403) {
    return {
      ok: false,
      reason: "permission",
      detail: `Token lacks the Browser Rendering permission on account ${accountId}`,
      hint: CLOUDFLARE_TOKEN_HINT,
    };
  }

  // Anything else is inconclusive rather than a failure: the endpoint may be
  // absent or renamed, and a wrong account ID looks the same from here. The
  // account read only runs now, to tell those apart, and its own 403 is not
  // held against a token that was never expected to have that permission.
  const account = await requestJson(
    fetchImpl,
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}`,
    { method: "GET", headers },
    timeoutMs,
  );
  if ("networkError" in account) return unreachable(account.networkError, "the Cloudflare API");
  if (account.status === 401) {
    return {
      ok: false,
      reason: "auth",
      detail: "Cloudflare rejected the API token (401)",
      hint: "The token is invalid, expired, or revoked. " + CLOUDFLARE_TOKEN_HINT,
    };
  }
  if (account.status === 404) {
    return {
      ok: false,
      reason: "config",
      detail: `Cloudflare account ${accountId} was not found`,
      hint: "Check the account ID on your Cloudflare dashboard overview page.",
    };
  }
  return {
    ok: true,
    detail: `Token accepted; Browser Rendering permission not confirmed (Cloudflare returned ${limits.status})`,
    permissionVerified: false,
  };
}

async function probeBrowserUse(
  apiKey: string | null,
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<ProviderProbe> {
  if (!apiKey) {
    return {
      ok: false,
      reason: "config",
      detail: "No API key is stored for this target",
      hint: "Create a key at https://cloud.browser-use.com and paste it here.",
    };
  }
  // Listing browsers is a read: it does not start a session, so it does not bill.
  const result = await requestJson(
    fetchImpl,
    "https://api.browser-use.com/api/v3/browsers",
    { method: "GET", headers: { "x-browser-use-api-key": apiKey } },
    timeoutMs,
  );
  if ("networkError" in result) return unreachable(result.networkError, "the Browser Use API");
  if (result.status === 401 || result.status === 403) {
    return {
      ok: false,
      reason: result.status === 401 ? "auth" : "permission",
      detail: `Browser Use rejected the API key (${result.status})`,
      hint: "Check the key at https://cloud.browser-use.com, or issue a new one.",
    };
  }
  if (result.status >= 400) {
    return {
      ok: false,
      reason: "network",
      detail: `Browser Use returned ${result.status}`,
      hint: "The provider reported an unexpected error. Retry in a moment.",
    };
  }
  return { ok: true, detail: "API key accepted", permissionVerified: true };
}

/** Map a CDP endpoint to the HTTP origin that serves `/json/version`. */
export function cdpHttpProbeUrl(cdpUrl: string): string | null {
  try {
    const url = new URL(cdpUrl);
    if (url.protocol === "ws:") url.protocol = "http:";
    else if (url.protocol === "wss:") url.protocol = "https:";
    else if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.search = "";
    url.hash = "";
    url.pathname = "/json/version";
    return url.toString();
  } catch {
    return null;
  }
}

async function probeGenericCdp(
  cdpUrl: string,
  headers: Record<string, string>,
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<ProviderProbe> {
  const probeUrl = cdpHttpProbeUrl(cdpUrl);
  if (!probeUrl) {
    return {
      ok: false,
      reason: "config",
      detail: "CDP URL is not a valid ws, wss, http, or https endpoint",
      hint: "Enter the endpoint your provider lists as the CDP or WebSocket URL.",
    };
  }
  const result = await requestJson(fetchImpl, probeUrl, { method: "GET", headers }, timeoutMs);
  if ("networkError" in result) {
    return {
      ok: false,
      reason: "network",
      detail: result.networkError,
      // Many hosted CDP endpoints accept WebSocket upgrades but do not serve
      // /json/version, so this is explicitly not framed as "broken".
      hint:
        "The endpoint did not answer an HTTP probe. That is normal for some providers; " +
        "if sessions work, this warning can be ignored.",
    };
  }
  if (result.status === 401 || result.status === 403) {
    return {
      ok: false,
      reason: result.status === 401 ? "auth" : "permission",
      detail: `CDP endpoint rejected the request (${result.status})`,
      hint: "Check the auth header name, prefix, and value for this endpoint.",
    };
  }
  if (result.status >= 400) {
    return {
      ok: true,
      detail: `Endpoint reachable; probe returned ${result.status}`,
      permissionVerified: false,
    };
  }
  const version = typeof result.body.Browser === "string" ? result.body.Browser : null;
  return {
    ok: true,
    detail: version ? `Reachable: ${version}` : "Endpoint reachable",
    permissionVerified: true,
  };
}

/**
 * Check a Vercel API token without provisioning anything.
 *
 * `/v2/user` is the cheapest call that proves the token is live; the team read
 * that follows is what catches a token issued under a personal account being
 * pointed at a team's project, which otherwise only surfaces when the first
 * sandbox fails to start.
 */
async function probeVercelToken(
  token: string,
  teamId: string | undefined,
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<ProviderProbe> {
  const headers = { authorization: `Bearer ${token}` };
  const user = await requestJson(
    fetchImpl,
    "https://api.vercel.com/v2/user",
    { method: "GET", headers },
    timeoutMs,
  );
  if ("networkError" in user) return unreachable(user.networkError, "the Vercel API");
  if (user.status === 401 || user.status === 403) {
    return {
      ok: false,
      reason: user.status === 401 ? "auth" : "permission",
      detail: `Vercel rejected the API token (${user.status})`,
      hint: "Create a token at https://vercel.com/account/settings/tokens and paste it here.",
    };
  }
  if (user.status >= 400) {
    return {
      ok: false,
      reason: "network",
      detail: `Vercel returned ${user.status}`,
      hint: "Vercel reported an unexpected error. Retry, then check vercel-status.com.",
    };
  }

  if (teamId) {
    const team = await requestJson(
      fetchImpl,
      `https://api.vercel.com/v2/teams/${encodeURIComponent(teamId)}`,
      { method: "GET", headers },
      timeoutMs,
    );
    if (!("networkError" in team) && (team.status === 403 || team.status === 404)) {
      return {
        ok: false,
        reason: "permission",
        detail: `This token cannot access team ${teamId} (${team.status})`,
        hint: "Issue the token under that team, or clear the team ID to use the token's own scope.",
      };
    }
  }

  // Sandbox entitlement is not readable from the API, so this stops short of
  // claiming the token can start a browser rather than guessing that it can.
  return {
    ok: true,
    detail: teamId
      ? "Token accepted for this team; sandbox entitlement not confirmed"
      : "Token accepted; sandbox entitlement not confirmed",
    permissionVerified: false,
  };
}

export type ProbeTarget =
  | {
      readonly provider: "vercel-sandbox";
      readonly auth?: "token" | "ambient";
      readonly teamId?: string;
      readonly projectId?: string;
    }
  | { readonly provider: "cloudflare-browser-run"; readonly accountId: string }
  | { readonly provider: "browser-use" }
  | {
      readonly provider: "generic-cdp";
      readonly cdpUrl: string;
      readonly authHeaderName?: string;
      readonly authPrefix?: string;
    };

/** Probe a configured target's credential without starting a browser session. */
export async function probeProvider(
  target: ProbeTarget,
  credential: string | null,
  deps: ProbeDeps = {},
): Promise<ProviderProbe> {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Default to the real host environment. Defaulting to `{}` made the Vercel
  // check report "VERCEL_OIDC_TOKEN is not set" on every production call, since
  // nothing outside the tests injects `deps.env`.
  const env = deps.env || process.env;

  switch (target.provider) {
    case "vercel-sandbox":
      // Two auth paths, two different things to check. A stored API token is a
      // real credential and gets a real probe; ambient OIDC is not a secret at
      // all, so there the only answerable question is whether the host has one.
      if (target.auth === "token") {
        // No team/project check: both are inferred from the token when unset,
        // so their absence is the normal case rather than a misconfiguration.
        return credential
          ? probeVercelToken(credential, target.teamId, fetchImpl, timeoutMs)
          : {
              ok: false,
              reason: "config",
              detail: "No Vercel API token is stored for this target",
              hint: "Create a token at https://vercel.com/account/settings/tokens and paste it here.",
            };
      }
      return env.VERCEL_OIDC_TOKEN
        ? { ok: true, detail: "Vercel OIDC identity is present", permissionVerified: false }
        : {
            ok: false,
            reason: "host",
            detail: "VERCEL_OIDC_TOKEN is not set on this Executor host",
            hint:
              "This target uses the host's ambient Vercel identity, which only exists when " +
              "Executor runs on Vercel. Add a target with a Vercel API token instead, or use " +
              "the setup prompt to put a token in the server's environment.",
          };
    case "cloudflare-browser-run":
      return probeCloudflare(target.accountId, credential, fetchImpl, timeoutMs);
    case "browser-use":
      return probeBrowserUse(credential, fetchImpl, timeoutMs);
    case "generic-cdp": {
      const headers =
        target.authHeaderName && credential
          ? { [target.authHeaderName]: `${target.authPrefix || ""}${credential}` }
          : {};
      return probeGenericCdp(target.cdpUrl, headers, fetchImpl, timeoutMs);
    }
  }
}

/** Executor health vocabulary: healthy | expired | degraded | unknown. */
export function probeToHealthStatus(
  probe: ProviderProbe,
): "healthy" | "expired" | "degraded" | "unknown" {
  if (probe.ok) return "healthy";
  if (probe.reason === "auth") return "expired";
  if (probe.reason === "network") return "unknown";
  return "degraded";
}
