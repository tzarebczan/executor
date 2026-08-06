import { describe, expect, it, vi } from "@effect/vitest";

import { createCloudBrowserSession } from "./cloud-providers";

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("cloud browser providers", () => {
  it("creates and closes a Cloudflare CDP session", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        response({
          sessionId: "cf-1",
          webSocketDebuggerUrl: "wss://cf.test/cdp",
          targets: [{ devtoolsFrontendUrl: "https://live.browser.run/session/cf-1" }],
        }),
      )
      .mockResolvedValueOnce(response({ status: "closing" }));
    const handle = await createCloudBrowserSession(
      { provider: "cloudflare-browser-run", accountId: "account", apiToken: "secret" },
      { fetch },
    );
    expect(handle.session).toMatchObject({
      sessionId: "cf-1",
      transport: "cdp",
      liveUrl: "https://live.browser.run/session/cf-1",
    });
    expect(fetch.mock.calls[0]?.[0]).toContain("keep_alive=600000");
    expect(fetch.mock.calls[0]?.[0]).toContain("targets=true");
    await handle.close();
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
  });

  it("creates and stops a Browser Use v3 browser", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        response({ id: "bu-1", cdpUrl: "wss://bu.test/cdp", liveUrl: "https://live.test" }, 201),
      )
      .mockResolvedValueOnce(response({ id: "bu-1", status: "stopped" }));
    const handle = await createCloudBrowserSession(
      { provider: "browser-use", apiKey: "secret", timeoutMinutes: 30 },
      { fetch },
    );
    expect(handle.session.liveUrl).toBe("https://live.test");
    await handle.close();
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "PATCH" });
  });

  it("runs typed commands through remote-agent-browser on Vercel", async () => {
    const exec = vi
      .fn()
      .mockResolvedValue({ ok: true, stdout: "ok", stderr: "", exitCode: 0, args: [] });
    const close = vi.fn().mockResolvedValue(undefined);
    const handle = await createCloudBrowserSession(
      { provider: "vercel-sandbox" },
      { createVercelBrowser: vi.fn().mockResolvedValue({ session: "vercel-1", exec, close }) },
    );
    await handle.run?.("open", ["https://example.com"]);
    expect(exec).toHaveBeenCalledWith("open", { args: ["https://example.com"] });
    await handle.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("uses the stored token instead of the host's ambient identity when one is set", async () => {
    // The ambient path is the one that only works on Vercel. If a token is
    // configured and this still fell through to `AgentBrowser.create`, the
    // target would fail on every self-hosted instance for want of a
    // VERCEL_OIDC_TOKEN it was never meant to need.
    const ambient = vi.fn();
    const tokenBrowser = vi
      .fn()
      .mockResolvedValue({ session: "vercel-1", exec: vi.fn(), close: vi.fn() });

    await createCloudBrowserSession(
      {
        provider: "vercel-sandbox",
        token: "vercel_abc",
        teamId: "team_1",
        projectId: "prj_1",
        vcpus: 4,
      },
      { createVercelBrowser: ambient, createTokenVercelBrowser: tokenBrowser },
    );

    expect(ambient).not.toHaveBeenCalled();
    expect(tokenBrowser).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "vercel_abc",
        teamId: "team_1",
        projectId: "prj_1",
        vcpus: 4,
      }),
    );
  });

  it("starts a token target that names no team or project", async () => {
    // Neither is required any more: the token path infers both. Passing them
    // as `undefined` rather than omitting them would defeat that, since the
    // adapter decides whether to infer by looking for the keys.
    const tokenBrowser = vi.fn().mockResolvedValue({ session: "v", exec: vi.fn(), close: vi.fn() });

    await createCloudBrowserSession(
      { provider: "vercel-sandbox", token: "vercel_abc" },
      { createTokenVercelBrowser: tokenBrowser },
    );

    expect(tokenBrowser).toHaveBeenCalledTimes(1);
    const passed = tokenBrowser.mock.calls[0]![0] as Record<string, unknown>;
    expect(passed.token).toBe("vercel_abc");
    expect("teamId" in passed).toBe(false);
    expect("projectId" in passed).toBe(false);
  });

  it("still uses the ambient identity when no token is configured", async () => {
    const ambient = vi.fn().mockResolvedValue({ session: "v", exec: vi.fn(), close: vi.fn() });
    const tokenBrowser = vi.fn();

    await createCloudBrowserSession(
      { provider: "vercel-sandbox" },
      { createVercelBrowser: ambient, createTokenVercelBrowser: tokenBrowser },
    );

    expect(tokenBrowser).not.toHaveBeenCalled();
    expect(ambient).toHaveBeenCalledOnce();
  });
});
