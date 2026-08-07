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

    expect(code).toContain('const account = "acct_9"');
    expect(code).toContain('"com.cloudflare.api.account." + account');
    expect(code).toContain('name: "Lab"');
  });

  it("tries both token scopes, since a grant may reach one and not the other", () => {
    // Cloudflare owns API tokens at user scope and at account scope. An
    // account-scoped MCP grant typically cannot touch /user/tokens, and
    // assuming either one made the mint fail on a route it never had.
    const code = cloudflareMintScript({ accountId: "acct_9", label: "Lab" });

    expect(code).toContain('"/accounts/" + account + "/tokens/permission_groups"');
    expect(code).toContain('"/user/tokens/permission_groups"');
    expect(code).toContain('"/accounts/" + account + "/tokens"');
    // The routes it tried come back with the result, so a refusal names the
    // endpoint that refused rather than only that something did.
    expect(code).toContain("attempts");
  });

  it("defers to the account the MCP grant already covers when none is named", () => {
    // Cloudflare's `execute` tool pre-binds `accountId`. Interpolating an empty
    // string instead would build the resource "com.cloudflare.api.account."
    // and mint a token scoped to nothing, which fails much later as a 403.
    const code = cloudflareMintScript({ accountId: "", label: "Lab" });

    // `accountId` unquoted is the tool's own binding; quoting it would name a
    // variable that does not exist, and an empty string would scope the policy
    // resource to nothing.
    expect(code).toContain("const account = accountId;");
    expect(code).not.toContain('const account = "";');
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
    expect(
      readMintScriptResult({
        minted: false,
        reason: "read-only",
        seen: ["Browser Rendering Read"],
      }),
    ).toMatchObject({ ok: false, reason: "not-found" });
    expect(
      readMintScriptResult({ minted: false, reason: "unavailable", total: 180 }),
    ).toMatchObject({ ok: false, reason: "not-found" });
  });

  it("does not blame the account when the permission list could not be read", () => {
    // An empty list because both routes were refused is not evidence that
    // Browser Rendering is unavailable. Reporting it that way sent someone to
    // check a Cloudflare plan that was never the problem.
    const outcome = readMintScriptResult({
      minted: false,
      reason: "unreadable",
      attempts: ["GET /accounts/a/tokens/permission_groups -> 403"],
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("permission");
    expect(outcome.detail).toContain("Could not read");
    expect(outcome.detail).toContain("403");
  });

  it("names the routes it tried on every failure, not just the last one", () => {
    const attempts = ["GET /accounts/a/tokens/permission_groups -> 200"];
    const unavailable = readMintScriptResult({
      minted: false,
      reason: "unavailable",
      total: 180,
      attempts,
    });
    const readOnly = readMintScriptResult({
      minted: false,
      reason: "read-only",
      seen: ["Browser Rendering Read"],
      attempts,
    });

    expect(unavailable.detail).toContain("tried GET /accounts/a/tokens/permission_groups -> 200");
    expect(unavailable.detail).toContain("180");
    expect(readOnly.detail).toContain("Browser Rendering Read");
  });

  it("reads JSON out of a markdown fence, or with prose in front of it", () => {
    // The same value comes back bare, fenced, and prefixed depending on the
    // server. Parsing only the whole string handled one of the three.
    const fenced = readMintScriptResult({
      content: [
        {
          type: "text",
          text: '```json\n{"minted":true,"token":"cf_a","permission":"Browser Rendering Edit"}\n```',
        },
      ],
    });
    const prefixed = readMintScriptResult({
      content: [{ type: "text", text: 'Result: {"minted":true,"token":"cf_b"}' }],
    });

    expect(fenced).toMatchObject({ ok: true, token: "cf_a" });
    expect(prefixed).toMatchObject({ ok: true, token: "cf_b" });
  });

  it("quotes what the server said when it cannot be read", () => {
    // "The Cloudflare MCP server returned a result this could not read" gave
    // the person holding it nothing to act on and nothing to report.
    const outcome = readMintScriptResult({
      isError: true,
      content: [{ type: "text", text: "Error: permission_groups is not readable by this token" }],
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.detail).toContain("permission_groups is not readable");
    expect(outcome.reason).toBe("permission");
  });

  it("does not claim success from a result it could not read", () => {
    expect(readMintScriptResult(null)).toMatchObject({ ok: false, reason: "provider" });
    expect(readMintScriptResult({ content: [{ type: "text", text: "" }] })).toMatchObject({
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
