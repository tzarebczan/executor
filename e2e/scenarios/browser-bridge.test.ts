// Cross-target: the Executor Browser reverse-bridge HTTP contract, driven the
// way the Chrome extension drives it — dial out with an API key, open a
// session, advertise scope, re-advertise it, long-poll, close.
//
// The scenario IS the extension: no browser is loaded, because what is under
// test is the server half of the loop. It covers the two things that were
// wrong before: the bridge accepted an ambient browser cookie, and the access
// scope an extension advertised could only ever be set once.
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { AccountHttpApi } from "@executor-js/api";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const bridge = (base: string, path: string) => new URL(`/api/browser-bridge${path}`, base);

scenario(
  "Browser bridge · an extension opens a session with an API key, re-advertises its scope, and closes",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: apiClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const account = yield* apiClient(AccountHttpApi, identity);

    const key = yield* account.account.createApiKey({ payload: { name: "e2e browser bridge" } });
    const asExtension = {
      "content-type": "application/json",
      authorization: `Bearer ${key.value}`,
    };

    // The extension dials out with a key. A page the user happens to have open
    // must not reach the bridge on the strength of their session cookie.
    const withCookieOnly = yield* Effect.promise(() =>
      fetch(bridge(target.baseUrl, "/session"), {
        method: "POST",
        headers: { "content-type": "application/json", ...(identity.headers ?? {}) },
        body: "{}",
      }),
    );
    expect(withCookieOnly.status, "a cookie alone does not authorize the bridge").toBe(401);

    const opened = yield* Effect.promise(() =>
      fetch(bridge(target.baseUrl, "/session"), {
        method: "POST",
        headers: asExtension,
        body: JSON.stringify({
          kind: "chrome-extension",
          transport: "reverse-longpoll",
          client: { name: "executor-browser", version: "e2e" },
          capabilities: {
            tools: ["ping", "snapshot"],
            access: { mode: "limited", sessionActive: false, advanced: false, allowedHosts: [] },
          },
        }),
      }).then((response) => response.json() as Promise<Record<string, unknown>>),
    );
    const sessionId = String(opened.sessionId);
    expect(sessionId, "the session reports one canonical id").not.toBe("undefined");
    expect(opened.id, "id and sessionId agree").toBe(opened.sessionId);

    yield* Effect.addFinalizer(() =>
      Effect.promise(() =>
        fetch(bridge(target.baseUrl, `/session/${sessionId}`), {
          method: "DELETE",
          headers: asExtension,
        }).then(() => undefined),
      ),
    );

    // Starting a control session widens what the extension permits. Re-advertising
    // has to reach Executor without reopening the channel, or the console shows
    // rules that are no longer the ones being enforced.
    const readvertised = yield* Effect.promise(() =>
      fetch(bridge(target.baseUrl, `/session/${sessionId}`), {
        method: "PATCH",
        headers: asExtension,
        body: JSON.stringify({
          capabilities: {
            tools: ["ping", "snapshot"],
            access: {
              mode: "full",
              sessionActive: true,
              advanced: true,
              allowedHosts: ["example.com"],
            },
          },
        }),
      }),
    );
    expect(readvertised.status, "the scope can be updated in place").toBe(200);

    const view = yield* Effect.promise(() =>
      fetch(bridge(target.baseUrl, `/session/${sessionId}`), { headers: asExtension }).then(
        (response) => response.json() as Promise<Record<string, unknown>>,
      ),
    );
    const access = (view.capabilities as { access?: Record<string, unknown> } | undefined)?.access;
    expect(access?.mode, "the session reports the scope most recently advertised").toBe("full");
    expect(access?.advanced, "and the Advanced flag with it").toBe(true);

    // An idle bridge parks on the long poll and comes back empty rather than erroring.
    const polled = yield* Effect.promise(() =>
      fetch(bridge(target.baseUrl, `/session/${sessionId}/jobs?waitMs=1000`), {
        headers: asExtension,
      }).then((response) => response.json() as Promise<{ jobs?: unknown[] }>),
    );
    expect(polled.jobs, "an idle poll yields no work").toEqual([]);

    // The listing speaks the canonical field; only the open response also
    // carries `id`, kept for older extension builds.
    const mine = yield* Effect.promise(() =>
      fetch(bridge(target.baseUrl, "/sessions"), { headers: asExtension }).then(
        (response) => response.json() as Promise<{ sessions?: Array<{ sessionId: string }> }>,
      ),
    );
    expect(
      mine.sessions?.some((session) => session.sessionId === sessionId),
      "the session is listed for its own owner",
    ).toBe(true);
  }).pipe(Effect.scoped),
);
