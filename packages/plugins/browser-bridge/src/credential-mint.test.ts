/* oxlint-disable executor/no-error-constructor, executor/no-json-parse -- test fixture: a rejected fetch is the only way to exercise the network branch this module reports, and asserting the token's scope means reading back the request body this module serialised */

import { describe, expect, it, vi } from "@effect/vitest";

import {
  cloudflareBrowserPermissionGroup,
  cloudflareMintScript,
  mintCloudflareBrowserToken,
  readMintScriptResult,
} from "./credential-mint";

describe("cloudflareMintScript", () => {
  it("scopes the policy to a named account", () => {
    const code = cloudflareMintScript({ accountId: "acct_9", label: "Lab" });

    expect(code).toContain('"com.cloudflare.api.account." + "acct_9"');
    expect(code).toContain('name: "Lab"');
  });

  it("defers to the account the MCP grant already covers when none is named", () => {
    // Cloudflare's `execute` tool pre-binds `accountId`. Interpolating an empty
    // string instead would build the resource "com.cloudflare.api.account."
    // and mint a token scoped to nothing, which fails much later as a 403.
    const code = cloudflareMintScript({ accountId: "", label: "Lab" });

    expect(code).toContain('"com.cloudflare.api.account." + accountId');
    expect(code).not.toContain('+ ""');
  });
});

describe("readMintScriptResult", () => {
  it("reads a token out of an MCP text content block", () => {
    // MCP servers return JSON as text as often as they return it structured,
    // and misreading a success would leave a real token created on the account
    // with nothing holding it.
    const outcome = readMintScriptResult({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            minted: true,
            token: "cf_minted",
            permission: "Browser Rendering Edit",
          }),
        },
      ],
    });

    expect(outcome).toMatchObject({ ok: true, token: "cf_minted" });
  });

  it("reads a structured result just as well", () => {
    const outcome = readMintScriptResult({
      structuredContent: { minted: true, token: "cf_minted", permission: "Browser Rendering Edit" },
    });

    expect(outcome).toMatchObject({ ok: true, token: "cf_minted" });
  });

  it("reports Cloudflare's own refusal rather than a generic failure", () => {
    const outcome = readMintScriptResult({
      minted: false,
      reason: "rejected",
      errors: [{ code: 9109, message: "Invalid access token" }],
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.detail).toContain("Invalid access token");
  });

  it("distinguishes a read-only permission from an absent one", () => {
    expect(readMintScriptResult({ minted: false, reason: "read-only" })).toMatchObject({
      ok: false,
      reason: "not-found",
    });
    expect(readMintScriptResult({ minted: false, reason: "unavailable" })).toMatchObject({
      ok: false,
      reason: "not-found",
    });
  });

  it("does not claim success from a result it could not read", () => {
    expect(readMintScriptResult(null)).toMatchObject({ ok: false, reason: "provider" });
    expect(readMintScriptResult({ content: [{ type: "text", text: "not json" }] })).toMatchObject({
      ok: false,
      reason: "provider",
    });
  });
});

const GROUPS = "/user/tokens/permission_groups";
const TOKENS = "/user/tokens";

const respond = (routes: Record<string, { status: number; body?: unknown }>) =>
  vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
    const url = String(input);
    // Longest match wins: "/user/tokens" must not shadow the permission groups
    // route, which shares its prefix.
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

const groupList = (...names: string[]) => ({
  status: 200,
  body: { result: names.map((name, index) => ({ id: `pg_${index}`, name })) },
});

const now = () => 1_700_000_000_000;

describe("cloudflareBrowserPermissionGroup", () => {
  it("finds the writable Browser Rendering group", async () => {
    const found = await cloudflareBrowserPermissionGroup("cred", {
      fetch: respond({
        [GROUPS]: groupList("Zone Read", "Browser Rendering Read", "Browser Rendering Edit"),
      }),
    });

    expect(found).toEqual({ id: "pg_2", name: "Browser Rendering Edit" });
  });

  it("refuses a read-only group rather than minting a token that cannot browse", async () => {
    // A read group mints cleanly and then fails at the first session with a
    // 403, which reads as a broken provider rather than a wrong permission.
    const found = await cloudflareBrowserPermissionGroup("cred", {
      fetch: respond({ [GROUPS]: groupList("Browser Rendering Read") }),
    });

    expect(found).toMatchObject({ reason: "not-found" });
  });

  it("separates a credential that cannot read permissions from an absent capability", async () => {
    const denied = await cloudflareBrowserPermissionGroup("cred", {
      fetch: respond({ [GROUPS]: { status: 403 } }),
    });
    const absent = await cloudflareBrowserPermissionGroup("cred", {
      fetch: respond({ [GROUPS]: groupList("Zone Read") }),
    });

    expect(denied).toMatchObject({ reason: "permission" });
    expect(absent).toMatchObject({ reason: "not-found" });
  });
});

describe("mintCloudflareBrowserToken", () => {
  it("scopes the new token to one account and to browser use alone", async () => {
    // The minting credential is usually an MCP connection with broad access.
    // Inheriting that breadth would make the browser target the most powerful
    // credential in the catalog, which is not what anyone asked for.
    const fetch = respond({
      [GROUPS]: groupList("Browser Rendering Edit"),
      [TOKENS]: { status: 200, body: { result: { id: "tok_1", value: "cf_new_token" } } },
    });

    const minted = await mintCloudflareBrowserToken(
      { token: "existing", accountId: "acct_9", label: "Lab browser" },
      { fetch, now },
    );

    expect(minted).toMatchObject({ ok: true, token: "cf_new_token" });
    const create = fetch.mock.calls.find(([url]) => String(url).endsWith(TOKENS))!;
    const body = JSON.parse(String(create[1]?.body));
    expect(body.policies).toHaveLength(1);
    expect(body.policies[0].resources).toEqual({ "com.cloudflare.api.account.acct_9": "*" });
    expect(body.policies[0].permission_groups).toEqual([{ id: "pg_0" }]);
    expect(body.name).toContain("Lab browser");
  });

  it("says the credential cannot create tokens rather than that it is invalid", async () => {
    // The distinction matters: the MCP connection works perfectly well, it just
    // was not granted API Tokens Write. Telling someone their token is bad
    // sends them to re-authenticate something that is not broken.
    const minted = await mintCloudflareBrowserToken(
      { token: "existing", accountId: "acct_9" },
      {
        fetch: respond({
          [GROUPS]: groupList("Browser Rendering Edit"),
          [TOKENS]: { status: 403 },
        }),
        now,
      },
    );

    expect(minted).toMatchObject({ ok: false, reason: "permission" });
    if (minted.ok) return;
    expect(minted.detail).toContain("API Tokens Write");
  });

  it("does not report success when Cloudflare withholds the secret", async () => {
    // The value is returned exactly once, at creation, and cannot be fetched
    // later. Storing an empty credential would produce a target that looks
    // configured and fails at every call.
    const minted = await mintCloudflareBrowserToken(
      { token: "existing", accountId: "acct_9" },
      {
        fetch: respond({
          [GROUPS]: groupList("Browser Rendering Edit"),
          [TOKENS]: { status: 200, body: { result: { id: "tok_1" } } },
        }),
        now,
      },
    );

    expect(minted).toMatchObject({ ok: false, reason: "provider" });
  });

  it("creates nothing when the permission group cannot be resolved", async () => {
    const fetch = respond({ [GROUPS]: { status: 403 } });

    const minted = await mintCloudflareBrowserToken(
      { token: "existing", accountId: "acct_9" },
      { fetch, now },
    );

    expect(minted.ok).toBe(false);
    expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("reports an unreachable provider as network, not as a bad credential", async () => {
    const minted = await mintCloudflareBrowserToken(
      { token: "existing", accountId: "acct_9" },
      { fetch: vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("ENOTFOUND")), now },
    );

    expect(minted).toMatchObject({ ok: false, reason: "network" });
  });
});
