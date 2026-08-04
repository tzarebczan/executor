import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

export const RemoteBrowserProvider = Schema.Literals([
  "vercel-sandbox",
  "cloudflare-browser-run",
  "browser-use",
  "generic-cdp",
]);

export const BrowserProviderDefinition = Schema.Struct({
  id: RemoteBrowserProvider,
  name: Schema.String,
  transport: Schema.Literals(["agent-browser", "cdp"]),
  availability: Schema.Literals(["available", "needs-setup", "unavailable"]),
  availabilityDetail: Schema.String,
  setup: Schema.String,
  note: Schema.String,
  configured: Schema.Number,
});

export const BrowserSessionView = Schema.Struct({
  sessionId: Schema.String,
  provider: RemoteBrowserProvider,
  transport: Schema.Literals(["agent-browser", "cdp"]),
  createdAt: Schema.Number,
  lastUsedAt: Schema.Number,
  liveUrl: Schema.optional(Schema.String),
  recordingUrl: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.String),
});

export const BrowserTargetView = Schema.Struct({
  integration: Schema.String,
  name: Schema.String,
  provider: Schema.Literals([
    "local-extension",
    "vercel-sandbox",
    "cloudflare-browser-run",
    "browser-use",
    "generic-cdp",
  ]),
  connection: Schema.optional(Schema.String),
  address: Schema.optional(Schema.String),
  state: Schema.Literals(["live", "ready", "offline", "needs-connection"]),
  detail: Schema.String,
  session: Schema.optional(BrowserSessionView),
});

export const BrowserOverview = Schema.Struct({
  providers: Schema.Array(BrowserProviderDefinition),
  targets: Schema.Array(BrowserTargetView),
  updatedAt: Schema.Number,
});

export const AddBrowserProviderPayload = Schema.Struct({
  provider: RemoteBrowserProvider,
  slug: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  connectionName: Schema.optional(Schema.String),
  credential: Schema.optional(Schema.String),
  accountId: Schema.optional(Schema.String),
  cdpUrl: Schema.optional(Schema.String),
  liveUrl: Schema.optional(Schema.String),
  authHeaderName: Schema.optional(Schema.String),
  authPrefix: Schema.optional(Schema.String),
  timeoutMs: Schema.optional(Schema.Number),
  vcpus: Schema.optional(Schema.Number),
  keepAliveMs: Schema.optional(Schema.Number),
  timeoutMinutes: Schema.optional(Schema.Number),
  profileId: Schema.optional(Schema.String),
  proxyCountryCode: Schema.optional(Schema.NullOr(Schema.String)),
  enableRecording: Schema.optional(Schema.Boolean),
});

export type AddBrowserProviderInput = typeof AddBrowserProviderPayload.Type;

export const BrowserControlApi = HttpApiGroup.make("browserControl")
  .add(
    HttpApiEndpoint.get("overview", "/browsers", {
      success: BrowserOverview,
      error: Schema.String,
    }),
  )
  .add(
    HttpApiEndpoint.post("addProvider", "/browsers", {
      payload: AddBrowserProviderPayload,
      success: BrowserTargetView,
      error: Schema.String,
    }),
  )
  .add(
    HttpApiEndpoint.post("stopSession", "/browsers/:integration/:connection/stop", {
      params: Schema.Struct({ integration: Schema.String, connection: Schema.String }),
      success: Schema.Struct({ stopped: Schema.Boolean }),
      error: Schema.String,
    }),
  );
