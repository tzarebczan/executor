import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createBridge, type BridgePrincipal } from "./bridge.ts";
import { renderBrowsersPage } from "./page.ts";

export interface BridgeAuth {
  readonly principal: BridgePrincipal | null;
  /** The credential could not be checked. This is not a rejected key. */
  readonly unavailable?: boolean;
}

/**
 * Mount the browser channel on a host HTTP server.
 *
 * `api` must accept only a presented credential. `page` may also accept the
 * dashboard session, so a signed-in person can see who is connected.
 * A rejected credential is `{ principal: null }` and the channel answers 401.
 * `{ unavailable: true }`, or an effect failure, answers 503. The extension
 * treats 401 as a bad key, so an outage must not look like one. The session
 * table is the one `createBridge()` closes over when these routes are built,
 * so build the route map once per process (local) or product actor (self-host).
 */
export const browserBridgeRoutes = <ApiE, ApiR, PageE, PageR>(authenticate: {
  readonly api: (request: Request) => Effect.Effect<BridgeAuth, ApiE, ApiR>;
  readonly page: (request: Request) => Effect.Effect<BridgeAuth, PageE, PageR>;
}) => {
  const bridge = createBridge();
  const unavailable = () =>
    HttpServerResponse.fromWeb(
      new Response(JSON.stringify({ error: "Executor could not check the credential. Try again." }), {
        status: 503,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      }),
    );
  const api = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const web = yield* HttpServerRequest.toWeb(request);
    const auth = yield* authenticate.api(web).pipe(
      Effect.orElseSucceed(() => ({ principal: null, unavailable: true })),
    );
    if (auth.unavailable) return unavailable();
    const response = yield* Effect.promise(() => bridge.handle(web, auth.principal));
    return HttpServerResponse.fromWeb(response);
  });
  const page = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const web = yield* HttpServerRequest.toWeb(request);
    const auth = yield* authenticate.page(web).pipe(
      Effect.orElseSucceed(() => ({ principal: null, unavailable: true })),
    );
    if (auth.unavailable) return unavailable();
    const principal = auth.principal;
    const html = renderBrowsersPage({
      signedIn: principal !== null,
      sessions: principal ? bridge.listPublic(principal.userId) : [],
      origin: new URL(web.url).origin,
    });
    return HttpServerResponse.fromWeb(
      new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      }),
    );
  });
  // A path ending in /* also matches the path without the suffix.
  return Layer.mergeAll(
    HttpRouter.add("*", "/api/browser-bridge/*", api),
    HttpRouter.add("GET", "/browsers", page),
  );
};
