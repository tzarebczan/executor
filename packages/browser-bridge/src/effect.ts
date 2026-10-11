import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createBridge, type BridgePrincipal } from "./bridge.ts";
import { renderBrowsersPage } from "./page.ts";

/**
 * Mount the browser channel on a host HTTP server.
 *
 * `api` must accept only a presented credential. `page` may also accept the
 * dashboard session, so a signed-in person can see who is connected.
 * A failed check is treated as signed out. The session table is the one
 * `createBridge()` closes over when these routes are built, so build the
 * route map once per process (local) or product actor (self-host).
 */
export const browserBridgeRoutes = <ApiE, ApiR, PageE, PageR>(authenticate: {
  readonly api: (request: Request) => Effect.Effect<BridgePrincipal | null, ApiE, ApiR>;
  readonly page: (request: Request) => Effect.Effect<BridgePrincipal | null, PageE, PageR>;
}) => {
  const bridge = createBridge();
  const api = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const web = yield* HttpServerRequest.toWeb(request);
    const principal = yield* authenticate.api(web).pipe(Effect.orElseSucceed(() => null));
    const response = yield* Effect.promise(() => bridge.handle(web, principal));
    return HttpServerResponse.fromWeb(response);
  });
  const page = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const web = yield* HttpServerRequest.toWeb(request);
    const principal = yield* authenticate.page(web).pipe(Effect.orElseSucceed(() => null));
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
