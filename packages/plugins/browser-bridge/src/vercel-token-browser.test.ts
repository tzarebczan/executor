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

  it("infers team and project from the token when neither is given", async () => {
    // The whole point of the token path: a pasted token is enough. Requiring
    // both IDs made three fields mandatory to reach a browser when the SDK can
    // answer two of them from the token itself.
    const createSandbox = vi.fn().mockResolvedValue(fakeSandbox());
    const inferScope = vi.fn().mockResolvedValue({ teamId: "team_inferred", projectId: "prj_new" });

    await createTokenVercelBrowser({ token: "vercel_abc" }, { createSandbox, inferScope });

    expect(inferScope).toHaveBeenCalledWith({ token: "vercel_abc" });
    expect(createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "team_inferred", projectId: "prj_new" }),
    );
  });

  it("keeps an explicitly named team while inferring the project under it", async () => {
    // A token with access to several teams resolves to the default one, so a
    // named team has to survive inference rather than be replaced by it, and
    // has to be passed down so the project is looked up in the right place.
    const createSandbox = vi.fn().mockResolvedValue(fakeSandbox());
    const inferScope = vi.fn().mockResolvedValue({ teamId: "team_default", projectId: "prj_x" });

    await createTokenVercelBrowser(
      { token: "vercel_abc", teamId: "team_chosen" },
      { createSandbox, inferScope },
    );

    expect(inferScope).toHaveBeenCalledWith({ token: "vercel_abc", teamId: "team_chosen" });
    expect(createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "team_chosen", projectId: "prj_x" }),
    );
  });

  it("does not call out to Vercel when both IDs are already known", async () => {
    // Inference costs an API round trip on every session start, and it would
    // also be free to override a deliberate choice. Neither is acceptable.
    const createSandbox = vi.fn().mockResolvedValue(fakeSandbox());
    const inferScope = vi.fn();

    await createTokenVercelBrowser(
      { token: "vercel_abc", teamId: "team_1", projectId: "prj_1" },
      { createSandbox, inferScope },
    );

    expect(inferScope).not.toHaveBeenCalled();
  });

  it("carries the browser environment the CLI expects", async () => {
    // Chromium cannot start in the sandbox without these flags. They are copied
    // from remote-agent-browser's own provisioning; dropping them produces a
    // sandbox that boots and then fails at the first page load.
    const createSandbox = vi.fn().mockResolvedValue(fakeSandbox());

    await createTokenVercelBrowser(
      { token: "t", teamId: "team_1", projectId: "prj_1" },
      { createSandbox },
    );

    const { env } = createSandbox.mock.calls[0]![0] as { env: Record<string, string> };
    expect(env.AGENT_BROWSER_ARGS).toContain("--no-sandbox");
    expect(env.AGENT_BROWSER_DEFAULT_TIMEOUT).toBeTruthy();
  });

  it("refuses to start without a token", async () => {
    const createSandbox = vi.fn();

    await expect(
      createTokenVercelBrowser(
        { token: "", teamId: "team_1", projectId: "prj_1" },
        { createSandbox },
      ),
    ).rejects.toThrow(/Vercel API token is required/);
    expect(createSandbox).not.toHaveBeenCalled();
  });

  it("runs agent-browser commands inside the sandbox", async () => {
    // The client is only useful if its commands reach the sandbox at all: a
    // runner wired to the wrong method would construct cleanly and then do
    // nothing on every call.
    const sandbox = fakeSandbox();
    const createSandbox = vi.fn().mockResolvedValue(sandbox);

    const browser = await createTokenVercelBrowser(
      { token: "t", teamId: "team_1", projectId: "prj_1" },
      { createSandbox },
    );
    await browser.exec("open", { args: ["https://example.com"] });

    expect(sandbox.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "agent-browser" }),
    );
  });

  it("stops the sandbox when the browser is closed", async () => {
    const sandbox = fakeSandbox();
    const createSandbox = vi.fn().mockResolvedValue(sandbox);

    const browser = await createTokenVercelBrowser(
      { token: "t", teamId: "team_1", projectId: "prj_1" },
      { createSandbox },
    );
    await browser.close();

    expect(sandbox.stop).toHaveBeenCalled();
  });
});

describe("provisioning without a browser image", () => {
  const runOf = (sandbox: { runCommand: ReturnType<typeof vi.fn> }) =>
    sandbox.runCommand.mock.calls.map(([input]) => (input as { cmd: string }).cmd);

  it("boots a stock runtime and installs the browser itself", async () => {
    // The documented path is to build an image and push it to the project's
    // Container Registry. Defaulting to an image nobody pushed made the first
    // session of every new target fail on a registry lookup for a name the user
    // had never heard of.
    const sandbox = fakeSandbox();
    const createSandbox = vi.fn().mockResolvedValue(sandbox);

    await createTokenVercelBrowser(
      { token: "t", teamId: "team_1", projectId: "prj_1" },
      { createSandbox },
    );

    const created = createSandbox.mock.calls[0]![0] as Record<string, unknown>;
    expect(created.runtime).toBe("node24");
    // `image` and `runtime` are mutually exclusive: passing the key at all,
    // even as undefined, is rejected by the Sandbox API.
    expect("image" in created).toBe(false);
    expect(runOf(sandbox)).toEqual(expect.arrayContaining(["npm", "agent-browser"]));
  });

  it("names the sandbox so a later session resumes it instead of rebuilding", async () => {
    // Without a name every session provisioned a fresh machine and reinstalled
    // the browser, so running the same target twice in a row was slow twice.
    const sandbox = fakeSandbox();
    const createSandbox = vi.fn().mockResolvedValue(sandbox);

    await createTokenVercelBrowser(
      { token: "t", teamId: "team_1", projectId: "prj_1", sandboxName: "executor-browser-abc" },
      { createSandbox },
    );

    const created = createSandbox.mock.calls[0]![0] as Record<string, unknown>;
    expect(created.name).toBe("executor-browser-abc");
    // The install moves into onCreate, which the SDK runs only for a sandbox it
    // actually created. Running it inline as well would reinstall on resume and
    // put the cost back on every call.
    expect(typeof created.onCreate).toBe("function");
    expect(runOf(sandbox)).not.toContain("npm");
  });

  it("still installs when the named sandbox is the one being created", async () => {
    const sandbox = fakeSandbox();
    const createSandbox = vi.fn().mockImplementation(async (input) => {
      await (input as { onCreate?: (s: unknown) => Promise<void> }).onCreate?.(sandbox);
      return sandbox;
    });

    await createTokenVercelBrowser(
      { token: "t", teamId: "team_1", projectId: "prj_1", sandboxName: "executor-browser-abc" },
      { createSandbox },
    );

    expect(runOf(sandbox)).toEqual(expect.arrayContaining(["npm", "agent-browser"]));
  });

  it("does not install on a named sandbox that boots from an image", async () => {
    const sandbox = fakeSandbox();
    const createSandbox = vi.fn().mockResolvedValue(sandbox);

    await createTokenVercelBrowser(
      {
        token: "t",
        teamId: "team_1",
        projectId: "prj_1",
        image: "my-browser:v2",
        sandboxName: "executor-browser-abc",
      },
      { createSandbox },
    );

    expect((createSandbox.mock.calls[0]![0] as Record<string, unknown>).onCreate).toBeUndefined();
  });

  it("uses a configured image and skips the install entirely", async () => {
    const sandbox = fakeSandbox();
    const createSandbox = vi.fn().mockResolvedValue(sandbox);

    await createTokenVercelBrowser(
      { token: "t", teamId: "team_1", projectId: "prj_1", image: "my-browser:v2" },
      { createSandbox },
    );

    const created = createSandbox.mock.calls[0]![0] as Record<string, unknown>;
    expect(created.image).toBe("my-browser:v2");
    expect("runtime" in created).toBe(false);
    expect(runOf(sandbox)).not.toContain("npm");
  });

  it("stops the sandbox when the install fails", async () => {
    // A half-built sandbox bills until its timeout and can never serve a
    // request, so leaving it running turns a setup error into a charge.
    const sandbox = fakeSandbox({
      runCommand: vi.fn().mockResolvedValue({
        wait: () => Promise.resolve({ exitCode: 1 }),
        output: (stream: string) =>
          Promise.resolve(stream === "stderr" ? "network unreachable" : ""),
        kill: () => Promise.resolve(),
      }),
    });
    const createSandbox = vi.fn().mockResolvedValue(sandbox);

    await expect(
      createTokenVercelBrowser(
        { token: "t", teamId: "team_1", projectId: "prj_1" },
        { createSandbox },
      ),
    ).rejects.toThrow(/could not install agent-browser/i);
    expect(sandbox.stop).toHaveBeenCalled();
  });
});
