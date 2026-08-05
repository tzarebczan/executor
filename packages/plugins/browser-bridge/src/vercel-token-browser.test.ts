import { describe, expect, it, vi } from "@effect/vitest";

import { createTokenVercelBrowser } from "./vercel-token-browser";

/**
 * A stand-in for one Vercel Sandbox.
 *
 * Nothing here provisions anything: a real `Sandbox.create` starts a billable
 * machine, so the adapter is exercised against a fake and the live path is
 * covered by the shape of the calls rather than by running them.
 */
function fakeSandbox(overrides: Record<string, unknown> = {}) {
  const runCommand = vi.fn().mockResolvedValue({
    wait: () => Promise.resolve({ exitCode: 0 }),
    output: (stream: string) => Promise.resolve(stream === "stdout" ? "" : ""),
    kill: () => Promise.resolve(),
  });
  return {
    runCommand,
    writeFiles: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("createTokenVercelBrowser", () => {
  it("passes the token, team, and project through to the sandbox", async () => {
    const createSandbox = vi.fn().mockResolvedValue(fakeSandbox());

    await createTokenVercelBrowser(
      { token: "vercel_abc", teamId: "team_1", projectId: "prj_1", vcpus: 4, timeoutMs: 60_000 },
      { createSandbox },
    );

    expect(createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "vercel_abc",
        teamId: "team_1",
        projectId: "prj_1",
        timeout: 60_000,
        resources: { vcpus: 4 },
      }),
    );
  });

  it("omits team and project rather than sending empty ones", async () => {
    // Vercel resolves the scope from the token when these are absent. Sending
    // an empty string instead would be a lookup for a team that does not exist.
    const createSandbox = vi.fn().mockResolvedValue(fakeSandbox());

    await createTokenVercelBrowser({ token: "vercel_abc" }, { createSandbox });

    const options = createSandbox.mock.calls[0]![0] as Record<string, unknown>;
    expect("teamId" in options).toBe(false);
    expect("projectId" in options).toBe(false);
  });

  it("carries the browser environment the CLI expects", async () => {
    // Chromium cannot start in the sandbox without these flags. They are copied
    // from remote-agent-browser's own provisioning; dropping them produces a
    // sandbox that boots and then fails at the first page load.
    const createSandbox = vi.fn().mockResolvedValue(fakeSandbox());

    await createTokenVercelBrowser({ token: "t" }, { createSandbox });

    const { env } = createSandbox.mock.calls[0]![0] as { env: Record<string, string> };
    expect(env.AGENT_BROWSER_ARGS).toContain("--no-sandbox");
    expect(env.AGENT_BROWSER_DEFAULT_TIMEOUT).toBeTruthy();
  });

  it("refuses to start without a token", async () => {
    const createSandbox = vi.fn();

    await expect(createTokenVercelBrowser({ token: "" }, { createSandbox })).rejects.toThrow(
      /Vercel API token is required/,
    );
    expect(createSandbox).not.toHaveBeenCalled();
  });

  it("runs agent-browser commands inside the sandbox", async () => {
    // The client is only useful if its commands reach the sandbox at all: a
    // runner wired to the wrong method would construct cleanly and then do
    // nothing on every call.
    const sandbox = fakeSandbox();
    const createSandbox = vi.fn().mockResolvedValue(sandbox);

    const browser = await createTokenVercelBrowser({ token: "t" }, { createSandbox });
    await browser.exec("open", { args: ["https://example.com"] });

    expect(sandbox.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "agent-browser" }),
    );
  });

  it("stops the sandbox when the browser is closed", async () => {
    const sandbox = fakeSandbox();
    const createSandbox = vi.fn().mockResolvedValue(sandbox);

    const browser = await createTokenVercelBrowser({ token: "t" }, { createSandbox });
    await browser.close();

    expect(sandbox.stop).toHaveBeenCalled();
  });
});
