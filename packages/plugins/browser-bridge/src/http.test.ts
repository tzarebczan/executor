import { beforeEach, describe, expect, it } from "@effect/vitest";

import { makeBrowserBridgeHandler } from "./http";
import { _resetStoreForTests } from "./store";

beforeEach(() => {
  _resetStoreForTests();
});

describe("browser bridge HTTP surface", () => {
  it("does not expose a direct tool-call endpoint", async () => {
    const handler = makeBrowserBridgeHandler({
      getSession: async () => ({ user: { id: "user-1" } }),
    });
    const response = await handler(
      new Request("https://executor.test/api/browser-bridge/call", {
        method: "POST",
        body: JSON.stringify({ tool: "click", args: { selector: "button" } }),
      }),
    );

    expect(response.status).toBe(404);
  });

  it("returns 401 without auth", async () => {
    const handler = makeBrowserBridgeHandler({
      getSession: async () => null,
    });
    const response = await handler(
      new Request("https://executor.test/api/browser-bridge/session", { method: "POST" }),
    );
    expect(response.status).toBe(401);
  });

  it("returns one canonical sessionId field", async () => {
    const handler = makeBrowserBridgeHandler({
      getSession: async () => ({ user: { id: "user-1" } }),
    });
    const response = await handler(
      new Request("https://executor.test/api/browser-bridge/session", { method: "POST" }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(typeof body.sessionId).toBe("string");
    expect(body.id).toBe(body.sessionId);
  });
});
