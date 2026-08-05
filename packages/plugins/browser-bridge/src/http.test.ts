import { beforeEach, describe, expect, it } from "@effect/vitest";

import { makeBrowserBridgeHandler } from "./http";
import { _resetStoreForTests } from "./store";

beforeEach(() => {
  _resetStoreForTests();
});

/** The extension always dials out with an API key; every test speaks as it does. */
const withKey = (url: string, init: RequestInit = {}) =>
  new Request(url, { ...init, headers: { authorization: "Bearer test-key", ...init.headers } });

describe("browser bridge HTTP surface", () => {
  it("refuses a request carrying only a browser session cookie", async () => {
    // A page the user has open must not be able to reach the bridge on the
    // strength of their cookie, even though that cookie identifies them.
    const handler = makeBrowserBridgeHandler({
      getSession: async () => ({ user: { id: "user-1" } }),
    });
    const response = await handler(
      new Request("https://executor.test/api/browser-bridge/session", {
        method: "POST",
        headers: { cookie: "better-auth.session_token=abc" },
      }),
    );
    expect(response.status).toBe(401);
    expect((await response.json()).error).toContain("API key");
  });

  it("does not let a meaningless bearer header re-enable the cookie", async () => {
    // The precheck only proves a credential was presented. If the resolver can
    // still fall back to the cookie, `Authorization: Bearer anything` reopens
    // the door — so the cookie is removed before the resolver ever sees it.
    let sawCookie: string | null = "not-called";
    const handler = makeBrowserBridgeHandler({
      getSession: async (request) => {
        sawCookie = request.headers.get("cookie");
        return sawCookie ? { user: { id: "cookie-user" } } : null;
      },
    });
    const response = await handler(
      new Request("https://executor.test/api/browser-bridge/session", {
        method: "POST",
        headers: {
          authorization: "Bearer not-a-real-key",
          cookie: "better-auth.session_token=abc",
        },
      }),
    );
    expect(sawCookie, "the resolver never sees the ambient cookie").toBeNull();
    expect(response.status, "a junk bearer plus a cookie does not authenticate").toBe(401);
  });

  it("accepts the credential the extension actually presents", async () => {
    const handler = makeBrowserBridgeHandler({
      getSession: async () => ({ user: { id: "user-1" } }),
    });
    const bearer = await handler(
      withKey("https://executor.test/api/browser-bridge/session", { method: "POST" }),
    );
    expect(bearer.status).toBe(200);

    const apiKeyHeader = await handler(
      new Request("https://executor.test/api/browser-bridge/session", {
        method: "POST",
        headers: { "x-api-key": "test-key" },
      }),
    );
    expect(apiKeyHeader.status).toBe(200);
  });

  it("does not expose a direct tool-call endpoint", async () => {
    const handler = makeBrowserBridgeHandler({
      getSession: async () => ({ user: { id: "user-1" } }),
    });
    const response = await handler(
      withKey("https://executor.test/api/browser-bridge/call", {
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
      withKey("https://executor.test/api/browser-bridge/session", { method: "POST" }),
    );
    expect(response.status).toBe(401);
  });

  it("returns one canonical sessionId field", async () => {
    const handler = makeBrowserBridgeHandler({
      getSession: async () => ({ user: { id: "user-1" } }),
    });
    const response = await handler(
      withKey("https://executor.test/api/browser-bridge/session", { method: "POST" }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(typeof body.sessionId).toBe("string");
    expect(body.id).toBe(body.sessionId);
  });
});
