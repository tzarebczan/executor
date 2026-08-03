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
});
