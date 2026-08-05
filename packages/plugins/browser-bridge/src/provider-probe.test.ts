/* oxlint-disable executor/no-error-constructor -- test fixture: simulating a transport failure requires a rejected fetch, which is what the probe's network branch exists to handle */

import { describe, expect, it, vi } from "@effect/vitest";

import { cdpHttpProbeUrl, probeProvider, probeToHealthStatus } from "./provider-probe";

const respond = (routes: Record<string, { status: number; body?: unknown }>) =>
  vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
    const url = String(input);
    // Longest match wins: "/accounts/x" must not shadow "/accounts/x/browser-rendering/limits".
    const match = Object.keys(routes)
      .filter((key) => url.includes(key))
      .sort((left, right) => right.length - left.length)[0];
    const route = match ? routes[match]! : { status: 404, body: {} };
    return Promise.resolve(
      new Response(JSON.stringify(route.body ?? {}), {
        status: route.status,
        headers: { "content-type": "application/json" },
      }),
    );
  });

const rejecting = (message: string) =>
  vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error(message));

describe("probeProvider", () => {
  it("reports a revoked Cloudflare token as an auth failure, not a healthy target", async () => {
    const probe = await probeProvider(
      { provider: "cloudflare-browser-run", accountId: "acct" },
      "bad-token",
      { fetch: respond({ "/user/tokens/verify": { status: 401 } }) },
    );
    expect(probe.ok).toBe(false);
    if (probe.ok) return;
    expect(probe.reason).toBe("auth");
    expect(probe.hint).toContain("api-tokens");
    expect(probeToHealthStatus(probe)).toBe("expired");
  });

  it("distinguishes a missing Browser Rendering permission from a bad token", async () => {
    const probe = await probeProvider(
      { provider: "cloudflare-browser-run", accountId: "acct" },
      "scoped-token",
      {
        fetch: respond({
          "/user/tokens/verify": { status: 200, body: { success: true } },
          "/accounts/acct/browser-rendering/limits": { status: 403 },
          "/accounts/acct": { status: 200, body: { success: true } },
        }),
      },
    );
    expect(probe.ok).toBe(false);
    if (probe.ok) return;
    expect(probe.reason).toBe("permission");
    expect(probeToHealthStatus(probe)).toBe("degraded");
  });

  it("passes but marks the permission unconfirmed when the limits probe is unavailable", async () => {
    const probe = await probeProvider(
      { provider: "cloudflare-browser-run", accountId: "acct" },
      "token",
      {
        fetch: respond({
          "/user/tokens/verify": { status: 200 },
          "/accounts/acct/browser-rendering/limits": { status: 404 },
          "/accounts/acct": { status: 200 },
        }),
      },
    );
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.permissionVerified).toBe(false);
    expect(probe.detail).toContain("not confirmed");
  });

  it("separates an account-scope denial from a token rejection", async () => {
    const probe = await probeProvider(
      { provider: "cloudflare-browser-run", accountId: "other" },
      "token",
      {
        fetch: respond({
          "/user/tokens/verify": { status: 200 },
          "/accounts/other": { status: 403 },
        }),
      },
    );
    expect(probe.ok).toBe(false);
    if (probe.ok) return;
    expect(probe.reason).toBe("permission");
    expect(probe.detail).toContain("other");
  });

  it("treats an unreachable provider as unknown rather than failed credentials", async () => {
    const probe = await probeProvider({ provider: "browser-use" }, "key", {
      fetch: rejecting("getaddrinfo ENOTFOUND"),
    });
    expect(probe.ok).toBe(false);
    if (probe.ok) return;
    expect(probe.reason).toBe("network");
    expect(probeToHealthStatus(probe)).toBe("unknown");
  });

  it("accepts a working Browser Use key without starting a session", async () => {
    let method = "";
    const probe = await probeProvider({ provider: "browser-use" }, "key", {
      fetch: vi.fn<typeof globalThis.fetch>().mockImplementation((_input, init) => {
        method = String(init?.method);
        return Promise.resolve(new Response("[]", { status: 200 }));
      }),
    });
    expect(probe.ok).toBe(true);
    expect(method).toBe("GET");
  });

  it("reports a missing credential as configuration, not as an auth failure", async () => {
    const probe = await probeProvider({ provider: "browser-use" }, null, {});
    expect(probe.ok).toBe(false);
    if (probe.ok) return;
    expect(probe.reason).toBe("config");
  });

  it("reports the Vercel host prerequisite instead of a credential problem", async () => {
    const missing = await probeProvider({ provider: "vercel-sandbox" }, null, { env: {} });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.reason).toBe("host");

    const present = await probeProvider({ provider: "vercel-sandbox" }, null, {
      env: { VERCEL_OIDC_TOKEN: "t" },
    });
    expect(present.ok).toBe(true);
  });

  it("reads the host environment when the caller injects none", async () => {
    // Nothing outside the tests passes `deps.env`. Defaulting it to an empty
    // object made every production Vercel probe claim the token was missing.
    const original = process.env.VERCEL_OIDC_TOKEN;
    process.env.VERCEL_OIDC_TOKEN = "ambient-token";
    const probe = await probeProvider({ provider: "vercel-sandbox" }, null);
    if (original === undefined) delete process.env.VERCEL_OIDC_TOKEN;
    else process.env.VERCEL_OIDC_TOKEN = original;
    expect(probe.ok).toBe(true);
  });

  it("probes a stored Vercel token rather than looking at the host", async () => {
    // A token target does not care what the host's ambient identity is, so an
    // absent VERCEL_OIDC_TOKEN must not make a perfectly good token fail.
    const fetch = respond({
      "/v2/user": { status: 200, body: { user: { id: "u" } } },
      "/v2/teams/": { status: 200, body: { id: "team_1" } },
    });
    const probe = await probeProvider(
      {
        provider: "vercel-sandbox",
        auth: "token",
        teamId: "team_1",
        projectId: "prj_1",
      },
      "vercel_abc",
      { env: {}, fetch },
    );

    expect(probe.ok).toBe(true);
    expect(String(fetch.mock.calls[0]?.[0])).toContain("api.vercel.com/v2/user");
  });

  it("rejects a Vercel token the API refuses", async () => {
    const probe = await probeProvider(
      {
        provider: "vercel-sandbox",
        auth: "token",
        teamId: "team_1",
        projectId: "prj_1",
      },
      "bad",
      { fetch: respond({ "/v2/user": { status: 401 } }) },
    );

    expect(probe.ok).toBe(false);
    if (probe.ok) return;
    expect(probe.reason).toBe("auth");
  });

  it("catches a Vercel token that cannot reach the team it is pointed at", async () => {
    // The token is live, so /v2/user passes. Only the team read distinguishes
    // "valid token" from "valid token for the wrong scope", and that difference
    // otherwise surfaces as a sandbox that will not start.
    const probe = await probeProvider(
      {
        provider: "vercel-sandbox",
        auth: "token",
        teamId: "team_other",
        projectId: "prj_1",
      },
      "vercel_abc",
      {
        fetch: respond({
          "/v2/user": { status: 200, body: { user: { id: "u" } } },
          "/v2/teams/": { status: 403 },
        }),
      },
    );

    expect(probe.ok).toBe(false);
    if (probe.ok) return;
    expect(probe.reason).toBe("permission");
  });

  it("does not claim a Vercel token proves sandbox entitlement", async () => {
    // Vercel exposes no way to read this, so reporting it as verified would be
    // an invention — the same false green this whole probe layer exists to stop.
    const probe = await probeProvider(
      {
        provider: "vercel-sandbox",
        auth: "token",
        teamId: "team_1",
        projectId: "prj_1",
      },
      "vercel_abc",
      {
        fetch: respond({
          "/v2/user": { status: 200, body: { user: { id: "u" } } },
          "/v2/teams/": { status: 200, body: { id: "team_1" } },
        }),
      },
    );

    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.permissionVerified).toBe(false);
  });

  it("reports a token target with no token as configuration, not as a host problem", async () => {
    const probe = await probeProvider(
      {
        provider: "vercel-sandbox",
        auth: "token",
        teamId: "team_1",
        projectId: "prj_1",
      },
      null,
      { env: {} },
    );

    expect(probe.ok).toBe(false);
    if (probe.ok) return;
    expect(probe.reason).toBe("config");
  });

  it("reports legacy Vercel token targets with no scope as configuration failures", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const probe = await probeProvider({ provider: "vercel-sandbox", auth: "token" }, "vercel_abc", {
      fetch,
    });

    expect(probe.ok).toBe(false);
    if (probe.ok) return;
    expect(probe.reason).toBe("config");
    expect(probe.detail).toContain("Team ID and Project ID");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends the configured auth header to a generic CDP endpoint", async () => {
    let seen: Record<string, string> = {};
    const probe = await probeProvider(
      {
        provider: "generic-cdp",
        cdpUrl: "wss://cdp.test/session/abc",
        authHeaderName: "x-api-key",
        authPrefix: "",
      },
      "secret",
      {
        fetch: vi.fn<typeof globalThis.fetch>().mockImplementation((_input, init) => {
          seen = (init?.headers || {}) as Record<string, string>;
          return Promise.resolve(
            new Response(JSON.stringify({ Browser: "Chrome/140" }), { status: 200 }),
          );
        }),
      },
    );
    expect(seen["x-api-key"]).toBe("secret");
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.detail).toContain("Chrome/140");
  });

  it("does not call a CDP probe failure broken, since many endpoints are WS-only", async () => {
    const probe = await probeProvider(
      { provider: "generic-cdp", cdpUrl: "wss://ws-only.test" },
      null,
      { fetch: rejecting("socket hang up") },
    );
    expect(probe.ok).toBe(false);
    if (probe.ok) return;
    expect(probe.hint).toContain("can be ignored");
  });
});

describe("cdpHttpProbeUrl", () => {
  it("maps websocket endpoints onto their HTTP version endpoint", () => {
    expect(cdpHttpProbeUrl("wss://cdp.test/x?token=a#f")).toBe("https://cdp.test/json/version");
    expect(cdpHttpProbeUrl("ws://127.0.0.1:9222")).toBe("http://127.0.0.1:9222/json/version");
    expect(cdpHttpProbeUrl("https://cdp.test")).toBe("https://cdp.test/json/version");
  });

  it("rejects endpoints that are not CDP URLs", () => {
    expect(cdpHttpProbeUrl("not a url")).toBeNull();
    expect(cdpHttpProbeUrl("ftp://cdp.test")).toBeNull();
  });
});
