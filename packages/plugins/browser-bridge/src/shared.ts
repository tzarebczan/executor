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
  availability: Schema.Literals(["available", "needs-setup"]),
  availabilityDetail: Schema.String,
  setup: Schema.String,
  note: Schema.String,
  configured: Schema.Number,
  /**
   * Whether this Executor host carries an ambient credential for the provider,
   * so the UI can stop offering an auth path that cannot work here. Only Vercel
   * has one (`VERCEL_OIDC_TOKEN`); every other provider is always false.
   */
  hostIdentity: Schema.Boolean,
});

export const BrowserSessionView = Schema.Struct({
  sessionId: Schema.String,
  provider: RemoteBrowserProvider,
  transport: Schema.Literals(["agent-browser", "cdp"]),
  createdAt: Schema.Number,
  lastUsedAt: Schema.Number,
  /** When this session is closed for inactivity, unless something uses it first. */
  idleExpiresAt: Schema.Number,
  liveUrl: Schema.optional(Schema.String),
  recordingUrl: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.String),
});

/**
 * The limits the local extension is enforcing right now.
 *
 * Reported rather than assumed: the extension is the authority on its own
 * scope, and a user reading the console should see the same rules the
 * extension will apply, not the plugin's guess at them.
 */
export const BrowserAccessView = Schema.Struct({
  mode: Schema.Literals(["limited", "full"]),
  sessionActive: Schema.Boolean,
  advanced: Schema.Boolean,
  allowedHosts: Schema.Array(Schema.String),
  expiresAt: Schema.optional(Schema.Number),
});

export type BrowserAccessView = typeof BrowserAccessView.Type;

export const BrowserStartFailure = Schema.Struct({
  reason: Schema.Literals(["config", "auth", "permission", "quota", "network", "provider"]),
  detail: Schema.String,
  hint: Schema.String,
  failedAt: Schema.Number,
});

export type BrowserStartFailureView = typeof BrowserStartFailure.Type;

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
  /** `stale` is the same 90s rule the health check uses, so the card and the
   *  health dot cannot disagree about whether the bridge is answering. */
  state: Schema.Literals(["live", "stale", "ready", "offline", "needs-connection", "error"]),
  detail: Schema.String,
  session: Schema.optional(BrowserSessionView),
  access: Schema.optional(BrowserAccessView),
  failure: Schema.optional(BrowserStartFailure),
});

export type BrowserTargetView = typeof BrowserTargetView.Type;

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
  /** Adopt an existing connection's secret instead of pasting one. Both halves
   *  are required together, and only ever set by an explicit user choice. */
  reuseIntegration: Schema.optional(Schema.String),
  reuseConnection: Schema.optional(Schema.String),
  accountId: Schema.optional(Schema.String),
  /** Vercel: `token` reads this target's connection secret, `ambient` uses the
   *  host's own Vercel identity. Defaults to `token`, which works anywhere. */
  vercelAuth: Schema.optional(Schema.Literals(["token", "ambient"])),
  teamId: Schema.optional(Schema.String),
  projectId: Schema.optional(Schema.String),
  image: Schema.optional(Schema.String),
  cdpUrl: Schema.optional(Schema.String),
  liveUrl: Schema.optional(Schema.String),
  authHeaderName: Schema.optional(Schema.String),
  authPrefix: Schema.optional(Schema.String),
  timeoutMs: Schema.optional(Schema.Number),
  /** Minutes a session may sit unused before it is closed. */
  idleTimeoutMinutes: Schema.optional(Schema.Number),
  /** Expose evaluate, pdf, console, network, dialogs, and viewport. Default true. */
  allowAdvanced: Schema.optional(Schema.Boolean),
  vcpus: Schema.optional(Schema.Number),
  keepAliveMs: Schema.optional(Schema.Number),
  timeoutMinutes: Schema.optional(Schema.Number),
  profileId: Schema.optional(Schema.String),
  proxyCountryCode: Schema.optional(Schema.NullOr(Schema.String)),
  enableRecording: Schema.optional(Schema.Boolean),
});

export type AddBrowserProviderInput = typeof AddBrowserProviderPayload.Type;

/**
 * Result of checking one browser target on demand.
 *
 * A target being configured is not evidence that it works, so this is reported
 * separately from `state`: `ok` means the check actually succeeded, `verified`
 * distinguishes "the credential carries the permission we need" from "the
 * credential was accepted but we could not confirm the permission".
 */
export const BrowserConnectionTest = Schema.Struct({
  ok: Schema.Boolean,
  /** Why the check failed. Absent when `ok`. */
  reason: Schema.optional(
    Schema.Literals(["network", "auth", "permission", "config", "host"] as const),
  ),
  detail: Schema.String,
  /** One actionable sentence. Absent when nothing needs doing. */
  hint: Schema.optional(Schema.String),
  verified: Schema.Boolean,
  checkedAt: Schema.Number,
});

export type BrowserConnectionTestView = typeof BrowserConnectionTest.Type;

/**
 * Result of actually driving the browser once.
 *
 * Separate from `BrowserConnectionTest` because it answers a different
 * question. The credential check proves a token is live; it starts nothing, so
 * it cannot tell you the provider will hand you a working browser. "Token
 * accepted; sandbox entitlement not confirmed" is an honest answer to the wrong
 * question when what you want to know is whether this thing browses.
 *
 * This one starts a real session, loads a page, and stops it again, so it costs
 * whatever one short session costs. Never run automatically.
 */
export const BrowserTrialRun = Schema.Struct({
  ok: Schema.Boolean,
  detail: Schema.String,
  hint: Schema.optional(Schema.String),
  /** Title of the page that was actually loaded. Absent when the run failed. */
  title: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  /** Wall-clock time for start, navigate, and stop together. */
  ms: Schema.Number,
  ranAt: Schema.Number,
});

export type BrowserTrialRunView = typeof BrowserTrialRun.Type;

/**
 * An existing credential that might also work for a browser provider.
 *
 * Carries no secret value: it names a connection the user already owns so they
 * can choose to reuse it. Nothing is adopted without that choice.
 */
export const ReusableCredential = Schema.Struct({
  integration: Schema.String,
  integrationName: Schema.String,
  connection: Schema.String,
  address: Schema.String,
  identityLabel: Schema.optional(Schema.String),
});

export type ReusableCredentialView = typeof ReusableCredential.Type;

/**
 * Every failure on these routes is the caller's to fix.
 *
 * A bare `Schema.String` error carries no status annotation, and HttpApi
 * defaults an unannotated error to 500, so "paste an account ID" and "that
 * token was rejected" both reached the browser as `POST /api/browsers 500
 * (Internal Server Error)`. The message was in the body and did render in the
 * form, but the console said the server had crashed, which is the wrong thing
 * to tell anyone: it sends them to the server logs for a problem in their
 * input. Every other plugin in the repo annotates its errors; this one did not.
 */
const BrowserControlError = Schema.String.annotate({ httpApiStatus: 400 });

export const BrowserControlApi = HttpApiGroup.make("browserControl")
  .add(
    HttpApiEndpoint.get("overview", "/browsers", {
      success: BrowserOverview,
      error: BrowserControlError,
    }),
  )
  .add(
    HttpApiEndpoint.post("addProvider", "/browsers", {
      payload: AddBrowserProviderPayload,
      success: BrowserTargetView,
      error: BrowserControlError,
    }),
  )
  .add(
    HttpApiEndpoint.post("stopSession", "/browsers/:integration/:connection/stop", {
      params: Schema.Struct({ integration: Schema.String, connection: Schema.String }),
      success: Schema.Struct({ stopped: Schema.Boolean }),
      error: BrowserControlError,
    }),
  )
  .add(
    HttpApiEndpoint.delete("removeTarget", "/browsers/:integration/:connection", {
      params: Schema.Struct({ integration: Schema.String, connection: Schema.String }),
      success: Schema.Struct({ removed: Schema.Boolean }),
      error: BrowserControlError,
    }),
  )
  .add(
    HttpApiEndpoint.get("reusableCredentials", "/browsers/credentials/:provider", {
      params: Schema.Struct({ provider: RemoteBrowserProvider }),
      success: Schema.Array(ReusableCredential),
      error: BrowserControlError,
    }),
  )
  .add(
    HttpApiEndpoint.post("testConnection", "/browsers/:integration/:connection/test", {
      params: Schema.Struct({ integration: Schema.String, connection: Schema.String }),
      success: BrowserConnectionTest,
      error: BrowserControlError,
    }),
  )
  .add(
    HttpApiEndpoint.post("trialRun", "/browsers/:integration/:connection/trial", {
      params: Schema.Struct({ integration: Schema.String, connection: Schema.String }),
      success: BrowserTrialRun,
      error: BrowserControlError,
    }),
  );
