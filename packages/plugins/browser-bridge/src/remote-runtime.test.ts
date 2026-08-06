import { afterEach, describe, expect, it } from "@effect/vitest";
// oxlint-disable-next-line executor/no-vitest-import -- vi.mock hoisting must use Vitest directly
import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  exec: vi.fn(),
  screenshot: vi.fn(),
  upload: vi.fn(),
}));

vi.mock("./cloud-providers", () => ({
  createCloudBrowserSession: vi.fn(async () => ({
    session: {
      sessionId: "vercel-test",
      transport: "agent-browser" as const,
    },
    agentBrowser: mocks,
    close: mocks.close,
  })),
}));

import { createCloudBrowserSession } from "./cloud-providers";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  classifyRemoteBrowserFailure,
  getRemoteBrowserFailure,
  getRemoteBrowserSession,
  idleTimeoutMsFor,
  reapIdleRemoteBrowserSessions,
  runRemoteBrowserTool,
  stopAllRemoteBrowserSessions,
} from "./remote-runtime";

describe("remote browser runtime", () => {
  afterEach(async () => {
    await stopAllRemoteBrowserSessions();
    vi.clearAllMocks();
  });

  it("maps Vercel string tab ids and snapshot refs to the typed browser protocol", async () => {
    mocks.exec.mockImplementation(
      async (command: string, options?: { args?: readonly string[] }) => {
        if (command === "tab" && !options?.args?.length) {
          return {
            ok: true,
            data: {
              tabs: [
                {
                  tabId: "t7",
                  title: "Example",
                  url: "https://example.com/",
                  active: true,
                },
              ],
            },
          };
        }
        if (command === "snapshot") {
          return {
            ok: true,
            data: {
              snapshot: "- button Submit [ref=e4]",
              refs: { e4: { role: "button", name: "Submit" } },
            },
          };
        }
        return { ok: true, data: {} };
      },
    );

    const config = { provider: "vercel-sandbox" as const };
    const tabs = await runRemoteBrowserTool({
      key: "vercel:test",
      config,
      credential: null,
      tool: "tabs.list",
      args: {},
    });
    expect(tabs).toMatchObject({
      ok: true,
      tabs: [{ id: 1, title: "Example", active: true }],
    });

    const snapshot = await runRemoteBrowserTool({
      key: "vercel:test",
      config,
      credential: null,
      tool: "snapshot",
      args: {},
    });
    expect(snapshot).toMatchObject({
      ok: true,
      snapshot: { nodes: [{ index: 0, selector: "@e4", role: "button", name: "Submit" }] },
    });

    await runRemoteBrowserTool({
      key: "vercel:test",
      config,
      credential: null,
      tool: "click",
      args: { nodeIndex: 0 },
    });
    expect(mocks.exec).toHaveBeenLastCalledWith("click", { args: ["@e4"] });

    await runRemoteBrowserTool({
      key: "vercel:test",
      config,
      credential: null,
      tool: "tabs.activate",
      args: { tabId: 1 },
    });
    expect(mocks.exec).toHaveBeenLastCalledWith("tab", {
      args: ["t7"],
      flags: undefined,
      output: "json",
    });
  });

  it("retains an actionable configuration failure after a cold start fails", async () => {
    vi.mocked(createCloudBrowserSession).mockRejectedValueOnce({
      message: "Missing credentials parameters to access the Vercel API: teamId, projectId",
    });
    const key = "vercel:missing-scope";

    await expect(
      runRemoteBrowserTool({
        key,
        config: { provider: "vercel-sandbox" },
        credential: "secret",
        tool: "tabs.list",
        args: {},
      }),
    ).rejects.toThrow(/teamId, projectId/);

    expect(getRemoteBrowserFailure(key)).toMatchObject({
      reason: "config",
      detail: expect.stringContaining("setup is incomplete"),
      hint: expect.stringContaining("team and project IDs"),
    });
  });

  it("classifies provider credit failures without exposing the raw error", () => {
    const failure = classifyRemoteBrowserFailure(
      "vercel:no-credit",
      "vercel-sandbox",
      { message: "Payment required: insufficient credits for secret account abc" },
      123,
    );

    expect(failure).toMatchObject({
      reason: "quota",
      detail:
        "Vercel Sandbox could not start because the account has no available credits or quota",
      failedAt: 123,
    });
    expect(failure.detail).not.toContain("secret account abc");
    expect(failure.hint).not.toContain("secret account abc");
  });

  it("classifies a missing Vercel project or VCR image as setup", () => {
    const failure = classifyRemoteBrowserFailure(
      "vercel:missing-image",
      "vercel-sandbox",
      { message: "Status code 404 is not ok" },
      456,
    );

    expect(failure).toMatchObject({
      reason: "config",
      detail: "Vercel Sandbox could not find the configured project or browser image",
      failedAt: 456,
    });
    expect(failure.hint).toContain("Vercel Container Registry");
  });
});

describe("idle session reaping", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await stopAllRemoteBrowserSessions();
    vi.clearAllMocks();
  });

  it("never holds a session longer than the provider itself would", () => {
    expect(idleTimeoutMsFor({ provider: "generic-cdp", cdpUrl: "wss://x" })).toBe(
      DEFAULT_IDLE_TIMEOUT_MS,
    );
    // A two-minute Browser Use session must not be held for the ten-minute default.
    expect(idleTimeoutMsFor({ provider: "browser-use", timeoutMinutes: 2 })).toBe(120_000);
    // A longer provider lifetime does not extend our own idle window.
    expect(idleTimeoutMsFor({ provider: "browser-use", timeoutMinutes: 240 })).toBe(
      DEFAULT_IDLE_TIMEOUT_MS,
    );
    // An explicit setting wins, still bounded by the provider.
    expect(
      idleTimeoutMsFor({
        provider: "cloudflare-browser-run",
        accountId: "a",
        idleTimeoutMs: 60_000,
      }),
    ).toBe(60_000);
  });

  it("closes a session that goes unused and leaves a fresh one alone", async () => {
    mocks.exec.mockResolvedValue({ ok: true, data: {} });
    const key = "vercel:reap";
    const config = { provider: "vercel-sandbox" as const, idleTimeoutMs: 60_000 };
    await runRemoteBrowserTool({ key, config, credential: null, tool: "ping", args: {} });

    const live = getRemoteBrowserSession(key);
    expect(live?.idleExpiresAt).toBeGreaterThan(Date.now());

    expect(await reapIdleRemoteBrowserSessions(Date.now())).toEqual([]);
    expect(getRemoteBrowserSession(key)).not.toBeNull();

    expect(await reapIdleRemoteBrowserSessions(Date.now() + 61_000)).toEqual([key]);
    expect(getRemoteBrowserSession(key)).toBeNull();
    expect(mocks.close).toHaveBeenCalled();
  });

  it("does not let repeated use push a session past the provider's own lifetime", async () => {
    // Browser Use and Vercel measure their timeout from creation, so a session
    // used every minute must not keep advertising a later and later expiry.
    mocks.exec.mockResolvedValue({ ok: true, data: {} });
    const key = "vercel:capped";
    const config = { provider: "vercel-sandbox" as const, timeoutMs: 120_000 };
    const start = Date.parse("2026-01-01T00:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(start);
    await runRemoteBrowserTool({ key, config, credential: null, tool: "ping", args: {} });

    vi.setSystemTime(start + 90_000);
    await runRemoteBrowserTool({ key, config, credential: null, tool: "ping", args: {} });

    expect(
      getRemoteBrowserSession(key)?.idleExpiresAt,
      "expiry is pinned to creation + the provider's lifetime",
    ).toBe(start + 120_000);
    expect(await reapIdleRemoteBrowserSessions(start + 121_000)).toEqual([key]);
  });

  it("creates one paid session when two calls race a cold target", async () => {
    mocks.exec.mockResolvedValue({ ok: true, data: {} });
    const key = "vercel:race";
    const config = { provider: "vercel-sandbox" as const };
    const [a, b] = await Promise.all([
      runRemoteBrowserTool({ key, config, credential: null, tool: "ping", args: {} }),
      runRemoteBrowserTool({ key, config, credential: null, tool: "ping", args: {} }),
    ]);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Two provider sessions would mean one is orphaned: unreachable by the
    // reaper and by stopAll, and billing until the provider gives up.
    expect(createCloudBrowserSession).toHaveBeenCalledTimes(1);
  });

  it("does not close a session out from under a call that outruns the window", async () => {
    // `ping` answers locally, so drive a tool that actually reaches the
    // provider and hold it open there.
    let release = () => {};
    let markStarted = () => {};
    const started = new Promise((resolve) => {
      markStarted = () => resolve(undefined);
    });
    mocks.exec.mockImplementation(async () => {
      markStarted();
      await new Promise((done) => {
        release = () => done(undefined);
      });
      return { ok: true, data: { tabs: [] } };
    });

    const key = "vercel:slow";
    const config = { provider: "vercel-sandbox" as const, idleTimeoutMs: 60_000 };
    const call = runRemoteBrowserTool({
      key,
      config,
      credential: null,
      tool: "tabs.list",
      args: {},
    });
    await started;

    // Long past the idle window, but the call has not come back yet.
    expect(await reapIdleRemoteBrowserSessions(Date.now() + 600_000)).toEqual([]);
    expect(getRemoteBrowserSession(key)).not.toBeNull();

    release();
    await call;
    expect(await reapIdleRemoteBrowserSessions(Date.now() + 600_000)).toEqual([key]);
  });

  it("extends the window when a session is used again before it lapses", async () => {
    mocks.exec.mockResolvedValue({ ok: true, data: {} });
    const key = "vercel:kept";
    const config = { provider: "vercel-sandbox" as const, idleTimeoutMs: 60_000 };
    const start = Date.parse("2026-01-01T00:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(start);
    await runRemoteBrowserTool({ key, config, credential: null, tool: "ping", args: {} });

    vi.setSystemTime(start + 45_000);
    await runRemoteBrowserTool({ key, config, credential: null, tool: "ping", args: {} });

    // Without the second call this instant is already past the first window's end.
    expect(await reapIdleRemoteBrowserSessions(start + 70_000)).toEqual([]);
    expect(getRemoteBrowserSession(key)?.idleExpiresAt).toBe(start + 105_000);

    expect(await reapIdleRemoteBrowserSessions(start + 106_000)).toEqual([key]);
  });
});

describe("classifyRemoteBrowserFailure across providers", () => {
  it("does not send Cloudflare users to a Vercel Container Registry", () => {
    // A 404 from Cloudflare means a wrong account ID or a disabled feature.
    // The Vercel-shaped remedy is not just unhelpful there, it is a wrong
    // instruction: there is no project or VCR image in that setup to fix.
    const failure = classifyRemoteBrowserFailure(
      "cf:missing",
      "cloudflare-browser-run",
      { message: "Cloud browser request failed (404): not found" },
      1,
    );

    expect(failure.hint).not.toContain("Vercel Container Registry");
    expect(failure.hint).not.toContain("Project ID");
    expect(failure.detail).not.toContain("browser image");
  });

  it("does not tell a Browser Use target to add team and project IDs", () => {
    const failure = classifyRemoteBrowserFailure(
      "bu:oops",
      "browser-use",
      { message: "Invalid project id supplied" },
      1,
    );

    expect(failure.hint).not.toContain("team and project IDs");
  });
});
