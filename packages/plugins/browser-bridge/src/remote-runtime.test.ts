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

import { runRemoteBrowserTool, stopAllRemoteBrowserSessions } from "./remote-runtime";

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
});
