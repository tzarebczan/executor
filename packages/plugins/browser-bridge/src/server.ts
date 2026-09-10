/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor, executor/no-switch-statement, executor/no-instanceof-error, executor/no-unknown-error-message -- plugin boundary normalizes schema, storage, and remote browser failures */

/**
 * Chrome desktop reverse channel (path B).
 *
 * One integration (`browser`) with one catalog connection per connected
 * extension instance. The first unlabeled Chrome stays `desktop` so existing
 * agents keep calling `tools.browser.user.desktop`. A second browser (Brave,
 * another Chrome profile) gets its own connection and tool prefix.
 * No static `browser` integration, that duplicated the row in the UI with no
 * status dot.
 */

import {
  definePlugin,
  tool,
  Context,
  Data,
  Effect,
  HttpApi,
  HttpApiBuilder,
  Schema,
  ToolName,
  ConnectionName,
  IntegrationSlug,
  AuthTemplateSlug,
  ToolAddress,
  type StaticToolSchema,
  type PluginCtx,
  type ResolveToolsResult,
  type ToolDef,
  toolCallerRef,
} from "@executor-js/sdk/core";

import {
  callTool,
  findSessionForConnection,
  listSessionsForUser,
  sessionPublicView,
  type BridgeSession,
} from "./store";
import {
  DEFAULT_LOCAL_CONNECTION,
  localBrowserDisplayName,
  localToolAddress,
} from "./local-identity";
import {
  BROWSER_TOOL_DEFINITIONS,
  BROWSER_TOOL_NAMES,
  browserToolCatalogName,
  browserToolNameFromCatalog,
  isAdvancedBrowserTool,
  validateBrowserToolCall,
  type BrowserToolName,
} from "./protocol";
import {
  browserAuthMethods,
  browserProviderName,
  LOCAL_BROWSER_CONFIG,
  parseBrowserIntegrationConfig,
  approvalIsSessionScoped,
  sessionApprovalScope,
  type BrowserIntegrationConfig,
} from "./integration-config";
import { CLOUD_BROWSER_PROVIDERS } from "./cloud-providers";
import { normalizeHost } from "./host-policy";
import {
  cloudflareMintScript,
  mintCloudflareBrowserToken,
  readMintScriptResult,
} from "./credential-mint";
import {
  inferCloudflareAccountId,
  probeProvider,
  probeToHealthStatus,
  type ProbeTarget,
  type ProviderProbe,
} from "./provider-probe";
import {
  classifyRemoteBrowserFailure,
  DEFAULT_IDLE_TIMEOUT_MS,
  getRemoteBrowserSession,
  withoutLiveLinks,
  getRemoteBrowserFailure,
  listRemoteBrowserSessions,
  runRemoteBrowserTool,
  startRemoteBrowserSession,
  stopAllRemoteBrowserSessions,
  stopRemoteBrowserSession,
} from "./remote-runtime";
import {
  BrowserControlApi,
  type AddBrowserProviderInput,
  type BrowserAccessView,
  type BrowserConnectionTestView,
  type BrowserStartFailureView,
  type BrowserTargetSettings,
  type ReusableCredentialView,
  type UpdateBrowserTargetPayload,
} from "./shared";

export interface BrowserBridgePluginOptions {
  readonly callTimeoutMs?: number;
}

export const BROWSER_INTEGRATION_SLUG = "browser";
export const BROWSER_CONNECTION_NAME = "desktop";

const schemaToStaticToolSchema = <A, I>(schema: Schema.Decoder<A, I>): StaticToolSchema<A, I> =>
  Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(schema) as never) as StaticToolSchema<
    A,
    I
  >;

const InstallOutput = Schema.Struct({
  ok: Schema.Boolean,
  integration: Schema.String,
  connection: Schema.String,
  address: Schema.String,
  note: Schema.String,
  connections: Schema.optional(
    Schema.Array(
      Schema.Struct({
        connection: Schema.String,
        address: Schema.String,
        label: Schema.optional(Schema.String),
        browser: Schema.optional(Schema.String),
      }),
    ),
  ),
});
const InstallOutputStd = schemaToStaticToolSchema(InstallOutput);

const noArgsSchema = {
  type: "object",
  additionalProperties: false,
} as const;

const tabTargetProperties = { tabId: { type: "integer", minimum: 0 } } as const;
const tabTargetSchema = {
  type: "object",
  properties: tabTargetProperties,
  additionalProperties: false,
} as const;
const urlSchema = { type: "string", pattern: "^https?://" } as const;

const approval = (description: string) => ({
  requiresApproval: true,
  approvalDescription: description,
});

class BrowserBridgeError extends Data.TaggedError("BrowserBridgeError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function browserBridgeError(cause: unknown, fallback: string): BrowserBridgeError {
  const message =
    cause && typeof cause === "object" && "message" in cause && typeof cause.message === "string"
      ? cause.message
      : typeof cause === "string"
        ? cause
        : fallback;
  return new BrowserBridgeError({ message, cause });
}

/** Prefer discrete tools; `call` re-validates args against the target tool schema. */
export const INNER_BROWSER_TOOLS = BROWSER_TOOL_NAMES;

export type InnerBrowserTool = BrowserToolName;

/** Session is degraded if extension has not polled within this window. */
export const SESSION_STALE_MS = 90_000;

type OwnerLike = { readonly tenant: string; readonly subject: string | null };

function userIdFromOwner(owner: OwnerLike): string {
  return String(owner.subject || owner.tenant || "anonymous");
}

/** Validate a tool call against the protocol schema before it reaches a bridge. */
export function validateInnerCall(
  toolRaw: unknown,
  argsRaw: unknown,
): { tool: InnerBrowserTool; args: Record<string, unknown> } {
  const call = validateBrowserToolCall(toolRaw, argsRaw);
  return { tool: call.tool, args: call.args as Record<string, unknown> };
}

export const BROWSER_TOOL_CATALOG_V1: readonly ToolDef[] = [
  {
    name: ToolName.make("status"),
    description:
      "List connected local browsers and their tool addresses. When more than one Executor Browser is connected, each has its own tools.browser.user.<connection> prefix — call that prefix, do not assume desktop is the only one.",
    inputSchema: noArgsSchema,
  },
  {
    name: ToolName.make("call"),
    description:
      "Generic bridge invoke. Prefer discrete tools. Args are re-validated against the target tool schema (no schema bypass).",
    inputSchema: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          enum: [...INNER_BROWSER_TOOLS],
        },
        args: { type: "object", additionalProperties: true },
        sessionId: { type: "string", minLength: 1 },
        timeoutMs: { type: "integer", minimum: 1_000, maximum: 120_000 },
      },
      required: ["tool"],
      additionalProperties: false,
    },
    // Always approve: target may be mutating or screenshot (sensitive)
    annotations: approval("Run a browser operation through the generic bridge call"),
  },
  {
    name: ToolName.make("snapshot"),
    description: "A11y-ish DOM snapshot (prefer over screenshot).",
    inputSchema: tabTargetSchema,
  },
  {
    name: ToolName.make("navigate"),
    description: "Navigate an Executor-group tab to an HTTP(S) URL.",
    inputSchema: {
      type: "object",
      properties: { ...tabTargetProperties, url: urlSchema, newTab: { type: "boolean" } },
      required: ["url"],
      additionalProperties: false,
    },
    annotations: approval("Navigate the user's Executor browser tab"),
  },
  {
    name: ToolName.make("click"),
    description: "Click by coordinates, selector, or snapshot node index.",
    inputSchema: {
      type: "object",
      properties: {
        ...tabTargetProperties,
        x: { type: "number" },
        y: { type: "number" },
        selector: { type: "string", minLength: 1 },
        nodeIndex: { type: "integer", minimum: 0, maximum: 199 },
      },
      additionalProperties: false,
    },
    annotations: approval("Click an element in the user's Executor browser tab"),
  },
  {
    name: ToolName.make("type"),
    description: "Type text into an input in an Executor-group tab.",
    inputSchema: {
      type: "object",
      properties: {
        ...tabTargetProperties,
        text: { type: "string" },
        selector: { type: "string", minLength: 1 },
        submit: { type: "boolean" },
      },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: approval("Type into the user's Executor browser tab"),
  },
  {
    name: ToolName.make("tabs_list"),
    description: "List Executor agent-group tabs.",
    inputSchema: noArgsSchema,
  },
  {
    name: ToolName.make("tabs_open"),
    description: "Open an HTTP(S) URL in a new Executor-group tab.",
    inputSchema: {
      type: "object",
      properties: { url: urlSchema, active: { type: "boolean" } },
      required: ["url"],
      additionalProperties: false,
    },
    annotations: approval("Open a new Executor browser tab"),
  },
  {
    name: ToolName.make("screenshot"),
    description: "JPEG of an Executor-group tab (may show sensitive content).",
    inputSchema: tabTargetSchema,
    annotations: approval("Capture a screenshot of the user's Executor browser tab"),
  },
  { name: ToolName.make("ping"), description: "Liveness check.", inputSchema: noArgsSchema },
];

function browserCatalogEntry(
  name: BrowserToolName,
  options: { readonly sessionScoped?: boolean } = {},
): ToolDef {
  const definition = BROWSER_TOOL_DEFINITIONS[name];
  const base = {
    name: ToolName.make(browserToolCatalogName(name)),
    description: definition.description,
    inputSchema: definition.inputSchema,
  };
  if (definition.risk === "read") return base;
  // On a target held to named hosts, approving the session is approving the
  // destinations, so ordinary actions inside it do not each need a person. On
  // an unbounded target these prompts are the only limit on where the browser
  // can be sent, and dropping them would leave nothing.
  //
  // Sensitive tools keep asking either way. An allowlist bounds where the
  // browser goes, not what runs once it is there.
  if (options.sessionScoped && definition.risk !== "sensitive") return base;
  return {
    ...base,
    annotations: approval(
      `${definition.risk === "sensitive" ? "Allow sensitive" : "Run"} browser operation: ${name}`,
    ),
  };
}

export const BROWSER_TOOL_CATALOG: readonly ToolDef[] = [
  BROWSER_TOOL_CATALOG_V1[0]!,
  BROWSER_TOOL_CATALOG_V1[1]!,
  ...BROWSER_TOOL_NAMES.map((name) => browserCatalogEntry(name)),
];

/**
 * The local extension's session tools.
 *
 * `session_start` is deliberately absent. The extension's control session is
 * what grants an agent reach over a browser that is signed into the user's own
 * accounts, and it is granted in the extension, by the person. A tool that
 * started one would let an agent hand itself the access the step exists to
 * withhold. Reading the session and ending it are both safe: one observes, and
 * the other only ever takes access away.
 */
const LOCAL_SESSION_TOOLS: readonly ToolDef[] = [
  {
    name: ToolName.make("session_status"),
    description:
      "Browser session status for this local Executor Browser connection: whether a control session is running, its access mode, which hosts are in scope, and when it expires. Does not start one.",
    inputSchema: noArgsSchema,
  },
  {
    name: ToolName.make("session_stop"),
    description:
      "End the local browser control session, returning the extension to its resting access. Safe to call when none is running.",
    inputSchema: noArgsSchema,
  },
];

function describeThisLocalBrowser(connectionName: string, label?: string): string {
  return ` This connection is the local ${label || connectionName} browser (${localToolAddress(connectionName)}).`;
}

function catalogResult(
  config?: BrowserIntegrationConfig | null,
  identity?: { readonly connectionName: string; readonly label?: string },
): ResolveToolsResult {
  const sessionScoped =
    config?.provider === "local-extension" && config.sessionScopedApproval === true;
  const note = identity ? describeThisLocalBrowser(identity.connectionName, identity.label) : "";
  const tools = [
    ...LOCAL_SESSION_TOOLS,
    BROWSER_TOOL_CATALOG_V1[0]!,
    BROWSER_TOOL_CATALOG_V1[1]!,
    ...BROWSER_TOOL_NAMES.map((name) => browserCatalogEntry(name, { sessionScoped })),
  ];
  return {
    tools: note
      ? tools.map((toolDef) =>
          String(toolDef.name) === "status" || String(toolDef.name) === "session_status"
            ? { ...toolDef, description: `${toolDef.description}${note}` }
            : toolDef,
        )
      : tools,
  };
}

/**
 * What the extension is currently advertising about its own access.
 *
 * Read live rather than from stored config, because it is the extension's
 * setting and not Executor's: the answer has to be whatever is true right now,
 * not what was true when this catalog was built.
 */
/**
 * Why a session-scoped local call must not proceed, if it must not.
 *
 * Dropping the per-action prompt on the local browser is only defensible while
 * the extension is bounding it to named hosts. In Full access mode the same
 * setting would mean one click covering the user's whole signed-in Chrome, so
 * the setting stops applying rather than silently meaning something larger than
 * it did when it was ticked.
 *
 * Reads are unaffected: they were never prompted.
 */
export function localScopeProblem(
  config: BrowserIntegrationConfig,
  ctx: PluginCtx,
  toolName: string,
  connectionName: string,
): string | null {
  return localScopeVerdict(
    config,
    accessFromCapabilities(
      findSessionForConnection(userIdFromOwner(ctx.owner), connectionName)?.capabilities,
    ),
    toolName,
  );
}

/** The decision itself, separated from looking up what the extension advertised. */
export function localScopeVerdict(
  config: BrowserIntegrationConfig,
  access: BrowserAccessView | null,
  toolName: string,
): string | null {
  if (config.provider !== "local-extension" || !config.sessionScopedApproval) return null;
  const inner = browserToolNameFromCatalog(toolName) || toolName;
  const definition = (BROWSER_TOOL_DEFINITIONS as Record<string, { risk?: string } | undefined>)[
    inner
  ];
  if (!definition || definition.risk === "read") return null;
  if (access && access.mode === "limited") return null;
  return (
    "This browser is set to ask once per session, which only applies while the extension is in " +
    "Limited access mode. It is not, so actions are not covered by that approval. Switch the " +
    "extension to Limited access with an allowed-hosts list, or turn off ask-once for this browser."
  );
}

export function localSessionStatus(ctx: PluginCtx, connectionName: string) {
  const session = findSessionForConnection(userIdFromOwner(ctx.owner), connectionName);
  if (!session) {
    const others = listSessionsForUser(userIdFromOwner(ctx.owner));
    return {
      active: false as const,
      connection: connectionName,
      address: localToolAddress(connectionName),
      detail:
        others.length === 0
          ? "The Executor Browser extension is not connected. Open the browser and check the extension is running."
          : `This connection (${localToolAddress(connectionName)}) is not live. Connected: ${others
              .map((live) => localToolAddress(live.connectionName))
              .join(", ")}.`,
    };
  }
  const access = accessFromCapabilities(session.capabilities);
  return {
    active: true as const,
    connection: session.connectionName,
    address: localToolAddress(session.connectionName),
    label: localBrowserDisplayName(session),
    ...(session.browser ? { browser: session.browser } : {}),
    connectedFor: Date.now() - session.createdAt,
    ...(access
      ? {
          mode: access.mode,
          controlSessionActive: access.sessionActive,
          advanced: access.advanced,
          allowedHosts: access.allowedHosts,
          ...(access.expiresAt ? { expiresAt: access.expiresAt } : {}),
        }
      : { detail: "The extension did not advertise its access scope" }),
  };
}

const REMOTE_SESSION_TOOLS: readonly ToolDef[] = [
  {
    name: ToolName.make("session_status"),
    description:
      "Browser session status: whether a remote browser is currently running, how long it has left, and its transport. Does not start one. `idleExpiresAt` is when the session closes if nothing uses it before then; the replacement session does not keep open tabs or sign-ins.",
    inputSchema: noArgsSchema,
  },
  {
    name: ToolName.make("session_start"),
    description:
      "Start a browser session, or reuse the one already running for this connection. Browser tools start a session on their own, so this is only needed to warm one up or to approve the session ahead of time.",
    inputSchema: noArgsSchema,
    annotations: approval("Start a remote browser session that may incur provider usage"),
  },
  {
    name: ToolName.make("session_stop"),
    description:
      "Stop the browser session and release the remote browser, ending what it is billed for. Safe to call when nothing is running.",
    inputSchema: noArgsSchema,
  },
];

/**
 * Whether a remote target exposes the Advanced tools.
 *
 * The local extension gates evaluate/pdf/console/network behind Advanced mode
 * and a live control session, because they run inside the user's own signed-in
 * Chrome. A remote target is a rented, isolated browser with no personal
 * session to leak, so the same tools are ordinary capability there and default
 * on. What was wrong before was not the default but the silence: the gate
 * existed on one side only and nothing said so. It is now a property of the
 * target, set once and enforced in both the catalog and the call.
 */
export function remoteAdvancedAllowed(
  config: Exclude<BrowserIntegrationConfig, { provider: "local-extension" }>,
): boolean {
  return config.allowAdvanced !== false;
}

export function remoteCatalogResult(
  config: Exclude<BrowserIntegrationConfig, { provider: "local-extension" }>,
): ResolveToolsResult {
  // Withheld rather than published-and-refused: an agent should not see a tool
  // this target will never run.
  const names = remoteAdvancedAllowed(config)
    ? BROWSER_TOOL_NAMES
    : BROWSER_TOOL_NAMES.filter((name) => !isAdvancedBrowserTool(name));
  const sessionScoped = approvalIsSessionScoped(config);
  return {
    tools: [
      ...remoteSessionTools(config),
      ...names.map((name) => browserCatalogEntry(name, { sessionScoped })),
    ],
  };
}

/**
 * The session tools, with the start prompt saying what it actually covers.
 *
 * Where one approval stands in for every action in the session, the prompt has
 * to state its own scope. Asking once for something broader than the person
 * understood is worse than asking often.
 */
function remoteSessionTools(
  config: Exclude<BrowserIntegrationConfig, { provider: "local-extension" }>,
): readonly ToolDef[] {
  if (!approvalIsSessionScoped(config)) return REMOTE_SESSION_TOOLS;
  const minutes = Math.round((config.idleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS) / 60_000);
  return REMOTE_SESSION_TOOLS.map((tool) =>
    String(tool.name) === "session_start"
      ? {
          ...tool,
          annotations: approval(
            `Start a remote browser session ${sessionApprovalScope(config)}. Browsing will not ask again until the session closes, which happens after ${minutes} minute${minutes === 1 ? "" : "s"} idle.`,
          ),
        }
      : tool,
  );
}

function remoteSessionKey(owner: OwnerLike, integration: string, connection: string): string {
  return `${userIdFromOwner(owner)}:${integration}:${connection}`;
}

/** Project a stored integration config onto the probe's input shape. */
function probeTargetFor(
  config: Exclude<BrowserIntegrationConfig, { provider: "local-extension" }>,
): ProbeTarget {
  switch (config.provider) {
    case "cloudflare-browser-run":
      return { provider: config.provider, accountId: config.accountId };
    case "vercel-sandbox":
      return {
        provider: config.provider,
        ...(config.auth ? { auth: config.auth } : {}),
        ...(config.teamId ? { teamId: config.teamId } : {}),
        ...(config.projectId ? { projectId: config.projectId } : {}),
      };
    case "generic-cdp":
      return {
        provider: config.provider,
        cdpUrl: config.cdpUrl,
        ...(config.auth?.kind === "header"
          ? { authHeaderName: config.auth.headerName, authPrefix: config.auth.prefix || "" }
          : {}),
      };
    default:
      return { provider: config.provider };
  }
}

function isRemoteBrowserConfig(
  config: BrowserIntegrationConfig | null,
): config is Exclude<BrowserIntegrationConfig, { provider: "local-extension" }> {
  return config !== null && config.provider !== "local-extension";
}

/**
 * Verdict for the local extension bridge.
 *
 * `checkHealth` and the on-demand connection test both report on the same
 * reverse session, so they read it through this one function rather than each
 * deciding for itself what "live", "stale", and "absent" mean.
 */
export function localBridgeVerdict(
  session: BridgeSession | undefined,
  now: number,
): { readonly status: "healthy" | "degraded"; readonly detail: string } {
  if (!session) {
    return {
      status: "degraded",
      detail: "Extension is not connected. Open the Executor Browser side panel and press Connect.",
    };
  }
  const ageMs = now - session.lastSeenAt;
  if (ageMs > SESSION_STALE_MS) {
    return {
      status: "degraded",
      detail: [
        `Extension stopped answering ${Math.round(ageMs / 1000)}s ago`,
        "Reconnect the Executor Browser side panel.",
      ].join(" · "),
    };
  }
  const client = (session.client || {}) as { name?: string; version?: string };
  const toolCount = ((session.capabilities || {}) as { tools?: string[] }).tools?.length ?? 0;
  // User-facing proof the extension answers. "Reverse"/session-id/ISO-timestamp
  // was transport vocabulary, true, but it read like a debug dump.
  const seenSecondsAgo = Math.max(0, Math.round(ageMs / 1000));
  return {
    status: "healthy",
    detail: [
      "Extension connected",
      client.name ? `${client.name} ${client.version || ""}`.trim() : null,
      toolCount ? `${toolCount} tools` : null,
      seenSecondsAgo <= 5 ? "answering now" : `last answered ${seenSecondsAgo}s ago`,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

/**
 * Words that suggest an existing connection holds a credential this provider
 * could use. Deliberately a hint, not a claim: a match only earns the
 * connection a place in a list the user chooses from, and the secret is not
 * read until they pick one and it passes a probe.
 */
const REUSE_HINTS: Record<
  Exclude<BrowserIntegrationConfig["provider"], "local-extension">,
  readonly string[]
> = {
  "cloudflare-browser-run": ["cloudflare"],
  "browser-use": ["browser-use", "browseruse"],
  // A Vercel API token is one credential across that whole account, so an
  // integration already holding one can back a sandbox browser too.
  "vercel-sandbox": ["vercel"],
  // A CDP endpoint's header value is specific to that endpoint; nothing else
  // in the catalog can be assumed to carry it.
  "generic-cdp": [],
};

export function credentialLooksReusable(
  provider: Exclude<BrowserIntegrationConfig["provider"], "local-extension">,
  integrationSlug: string,
  integrationName: string,
): boolean {
  const hints = REUSE_HINTS[provider];
  if (hints.length === 0) return false;
  const haystack = `${integrationSlug} ${integrationName}`.toLowerCase();
  return hints.some((hint) => haystack.includes(hint));
}

/**
 * Whether a connection's secret is the kind another target could adopt.
 *
 * `REUSE_HINTS` matches on the integration's name, so "Cloudflare MCP" is as
 * good a match as "Cloudflare DNS". The first holds an OAuth access token,
 * which is not a Browser Rendering API token and expires besides; copying one
 * into a browser target produces a credential that cannot work and reports
 * itself as a rejected token rather than the wrong credential.
 *
 * Static credentials only, then. An OAuth connection belongs to the app that
 * minted it.
 */
export function connectionOffersReusableSecret(
  connection: {
    readonly oauthClient?: string | null;
    readonly expiresAt?: number | null;
  },
  integration: { readonly kind: string } = { kind: "" },
): boolean {
  // An MCP connection's credential authenticates to an MCP *server*, not to the
  // provider's REST API. "Cloudflare MCP" holds a bearer for Cloudflare's MCP
  // endpoint; copying it into a browser target produced exactly one outcome,
  // `Cloudflare rejected the API token (401)`, which blamed the user's token for
  // a choice this code made for them.
  //
  // Checked by owning plugin because the connection row itself does not say:
  // the one under test carried no `oauthClient`, no `expiresAt`, and a custom
  // template slug, so every property-level guess about it was wrong.
  if (integration.kind === "mcp") return false;
  // `expiresAt` is checked as well as `oauthClient` because it is the property
  // that actually matters: a credential with an expiry is a session, and a copy
  // of it stops working without anything having changed on this target.
  return !connection.oauthClient && !connection.expiresAt;
}

/**
 * Whether this integration is one of our own browser targets.
 *
 * `REUSE_HINTS` matches on the integration's name, and a Vercel Sandbox target
 * is itself named "Vercel Sandbox", so every target offered its own credential
 * back for reuse. Adding a second target then listed the first alongside the
 * real Vercel integration, with nothing to tell them apart.
 */
export function integrationIsBrowserTarget(integration: { readonly kind: string }): boolean {
  return integration.kind === BROWSER_BRIDGE_PLUGIN_ID;
}

/** The `kind` every integration this plugin registers carries. */
export const BROWSER_BRIDGE_PLUGIN_ID = "browser-bridge";

/**
 * Whether a provider has an API for creating a browser credential.
 *
 * Only Cloudflare does: `POST /user/tokens` takes a policy and returns the
 * secret. Vercel issues API tokens through its dashboard, so offering the
 * button there would promise something that cannot be delivered, and a button
 * that always fails is worse than no button.
 */
export function providerCanMint(
  provider: Exclude<BrowserIntegrationConfig["provider"], "local-extension">,
): boolean {
  return provider === "cloudflare-browser-run";
}

/** Project a provider probe onto the connection-test view the UI renders. */
export function connectionTestFromProbe(
  probe: ProviderProbe,
  providerName: string,
  checkedAt: number,
): BrowserConnectionTestView {
  return probe.ok
    ? {
        ok: true,
        detail: `${providerName}: ${probe.detail}`,
        verified: probe.permissionVerified,
        checkedAt,
      }
    : {
        ok: false,
        reason: probe.reason,
        detail: `${providerName}: ${probe.detail}`,
        hint: probe.hint,
        verified: false,
        checkedAt,
      };
}

type BrowserTargetView = {
  readonly integration: string;
  readonly name: string;
  readonly provider: BrowserIntegrationConfig["provider"];
  readonly connection?: string;
  readonly address?: string;
  readonly state: "live" | "stale" | "ready" | "offline" | "needs-connection" | "error";
  readonly detail: string;
  readonly session?: Omit<ReturnType<typeof listRemoteBrowserSessions>[number], "key">;
  readonly access?: BrowserAccessView;
  readonly failure?: BrowserStartFailureView;
  readonly settings?: BrowserTargetSettings;
};

/**
 * Read the access scope the extension advertised.
 *
 * The extension is the authority on its own limits, so this reports what it
 * said rather than reconstructing it from the plugin's own settings, which
 * would agree right up to the moment it mattered.
 */
export function accessFromCapabilities(capabilities: unknown): BrowserAccessView | null {
  const access = (capabilities as { access?: unknown } | null | undefined)?.access;
  if (!access || typeof access !== "object") return null;
  const value = access as Record<string, unknown>;
  if (value.mode !== "limited" && value.mode !== "full") return null;
  const hosts = Array.isArray(value.allowedHosts)
    ? value.allowedHosts.filter((host): host is string => typeof host === "string")
    : [];
  return {
    mode: value.mode,
    sessionActive: value.sessionActive === true,
    advanced: value.advanced === true,
    allowedHosts: hosts,
    ...(typeof value.expiresAt === "number" ? { expiresAt: value.expiresAt } : {}),
  };
}

const remoteProviderSetup: Record<
  Exclude<BrowserIntegrationConfig["provider"], "local-extension">,
  { readonly setup: string; readonly note: string }
> = {
  "vercel-sandbox": {
    setup: "Vercel API token, or an ambient VERCEL_OIDC_TOKEN on the host",
    note: "Isolated agent-browser session in Vercel Sandbox",
  },
  "cloudflare-browser-run": {
    setup: "Account ID and Browser Rendering API token",
    note: "Managed Chromium over Cloudflare CDP",
  },
  "browser-use": {
    setup: "Browser Use API key",
    note: "Managed browser with optional live view and recording",
  },
  "generic-cdp": {
    setup: "CDP WebSocket URL and optional auth header",
    note: "Browserbase, Browserless, Kernel, or another CDP endpoint",
  },
};

/**
 * Whether this particular target can start given what the host has.
 *
 * Only one configuration depends on the host at all: a Vercel target that opted
 * for the ambient identity. A token-backed target carries its own credential
 * and is as startable here as anywhere.
 */
function remoteTargetHostReady(
  config: Exclude<BrowserIntegrationConfig, { provider: "local-extension" }>,
): boolean {
  if (config.provider !== "vercel-sandbox") return true;
  if (config.auth === "token") return true;
  return hostHasVercelIdentity();
}

/**
 * Whether the server process itself can authenticate to Vercel.
 *
 * Read at call time rather than at module load: the token is short-lived and
 * may be rotated into the environment while the process is running.
 */
export function hostHasVercelIdentity(): boolean {
  return Boolean(process.env.VERCEL_OIDC_TOKEN);
}

/**
 * How ready a provider is, and what to say about it.
 *
 * Vercel used to be reported `unavailable` whenever VERCEL_OIDC_TOKEN was
 * absent, which is every self-hosted instance, and the UI then disabled the
 * one button that would have explained how to fix it. It was never true that
 * the host made the provider impossible: a Vercel API token entered here works
 * anywhere. The missing OIDC token only decides which of the two setup paths is
 * open, so it is stated rather than enforced.
 */
function remoteProviderAvailability(
  provider: Exclude<BrowserIntegrationConfig["provider"], "local-extension">,
  configured: number,
): {
  readonly availability: "available" | "needs-setup";
  readonly availabilityDetail: string;
} {
  if (configured > 0) {
    return {
      availability: "available",
      availabilityDetail: `${configured} target${configured === 1 ? "" : "s"} configured`,
    };
  }
  if (provider === "vercel-sandbox" && !process.env.VERCEL_OIDC_TOKEN) {
    return {
      availability: "needs-setup",
      availabilityDetail: "No ambient Vercel identity here; add a Vercel API token",
    };
  }
  return {
    availability: "needs-setup",
    availabilityDetail: remoteProviderSetup[provider].setup,
  };
}

function withoutSessionKey(
  session: ReturnType<typeof listRemoteBrowserSessions>[number],
): Omit<typeof session, "key"> {
  const { key: _key, ...view } = session;
  return view;
}

function withoutFailureKey(
  failure: NonNullable<ReturnType<typeof getRemoteBrowserFailure>>,
): BrowserStartFailureView {
  const { key: _key, provider: _provider, ...view } = failure;
  return view;
}

/**
 * A stored config projected onto the settings a person may edit.
 *
 * Only what is actually set is included. Filling in defaults here would make an
 * edit form unable to distinguish a value someone chose from one nobody has
 * touched, and saving that form would turn every default into a decision.
 */
export function settingsFor(
  config: Exclude<BrowserIntegrationConfig, { provider: "local-extension" }>,
): BrowserTargetSettings {
  const shared = {
    ...(config.idleTimeoutMs === undefined
      ? {}
      : { idleTimeoutMinutes: Math.round(config.idleTimeoutMs / 60_000) }),
    ...(config.allowAdvanced === undefined ? {} : { allowAdvanced: config.allowAdvanced }),
    // Always sent, unlike the rest: absent and empty mean the same thing here
    // ("any public host"), and a form that cannot see the current list would
    // have to guess whether leaving it alone means keep or clear.
    allowedHosts: config.allowedHosts || [],
    ...(config.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
    ...(config.fullAccess ? { fullAccess: true } : {}),
  };
  switch (config.provider) {
    case "cloudflare-browser-run":
      return {
        ...shared,
        accountId: config.accountId,
        ...(config.keepAliveMs === undefined ? {} : { keepAliveMs: config.keepAliveMs }),
      };
    case "vercel-sandbox":
      return {
        ...shared,
        ...(config.teamId ? { teamId: config.teamId } : {}),
        ...(config.projectId ? { projectId: config.projectId } : {}),
        ...(config.image ? { image: config.image } : {}),
        ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
        ...(config.vcpus === undefined ? {} : { vcpus: config.vcpus }),
      };
    case "browser-use":
      return {
        ...shared,
        ...(config.timeoutMinutes === undefined ? {} : { timeoutMinutes: config.timeoutMinutes }),
        ...(config.profileId ? { profileId: config.profileId } : {}),
        ...(config.proxyCountryCode === undefined
          ? {}
          : { proxyCountryCode: config.proxyCountryCode }),
        ...(config.enableRecording === undefined
          ? {}
          : { enableRecording: config.enableRecording }),
      };
    default:
      return shared;
  }
}

/**
 * Apply a settings edit to a stored target.
 *
 * Absent means unchanged, so a client sends only what it touched and a field
 * this version of the UI does not know about survives being edited by it.
 * `allowedHosts` is deliberately different: an empty array clears the list,
 * because there has to be a way back to unrestricted browsing.
 */
function updateTargetEffect(
  ctx: PluginCtx,
  params: { readonly integration: string; readonly connection: string },
  input: UpdateBrowserTargetPayload,
) {
  return Effect.gen(function* () {
    const slug = IntegrationSlug.make(params.integration);
    const record = yield* ctx.core.integrations.get(slug);
    const current = record ? parseBrowserIntegrationConfig(record.config) : null;
    if (!record || !current) {
      return yield* new BrowserBridgeError({
        message: `No browser target "${params.integration}"`,
      });
    }
    // The local browser has exactly one setting here. Its access scope belongs
    // to the extension and is not duplicated; what Executor owns is whether the
    // prompts it raises are per action or per session.
    if (!isRemoteBrowserConfig(current)) {
      if (input.sessionScopedApproval === undefined) {
        return yield* new BrowserBridgeError({
          message:
            "The local browser's access scope is set in the Executor Browser extension. Only its approval frequency is configured here.",
        });
      }
      yield* ctx.core.integrations.update(slug, {
        config: {
          ...LOCAL_BROWSER_CONFIG,
          ...(input.sessionScopedApproval ? { sessionScopedApproval: true } : {}),
        } as never,
      });
      const refreshed = yield* browserOverviewEffect(ctx);
      const local = refreshed.targets.find((target) => target.integration === params.integration);
      if (!local) {
        return yield* new BrowserBridgeError({ message: "Saved, but the local browser vanished" });
      }
      return local;
    }

    const hosts =
      input.allowedHosts === undefined
        ? current.allowedHosts
        : [...new Set(input.allowedHosts.map(normalizeHost).filter(Boolean))];
    const allowPrivate =
      input.allowPrivateNetwork === undefined
        ? current.allowPrivateNetwork
        : input.allowPrivateNetwork;
    // The same rule the add form applies, checked here too: a client is not
    // where a safety rule is allowed to live.
    if (allowPrivate && !hosts?.length) {
      return yield* new BrowserBridgeError({
        message:
          "List the hosts this target may reach before allowing private addresses. A target that can reach a private network and every public one is not bounded by anything.",
      });
    }
    const idleMinutes = optionalNumber(input.idleTimeoutMinutes, "Idle timeout", {
      min: 1,
      max: 240,
      integer: true,
    });

    const next = {
      ...current,
      ...pickDefined({
        allowAdvanced: input.allowAdvanced,
        fullAccess: input.fullAccess,
        accountId: input.accountId?.trim(),
        keepAliveMs: input.keepAliveMs,
        teamId: input.teamId?.trim(),
        projectId: input.projectId?.trim(),
        image: input.image?.trim(),
        timeoutMs: input.timeoutMs,
        vcpus: input.vcpus,
        timeoutMinutes: input.timeoutMinutes,
        profileId: input.profileId?.trim(),
        proxyCountryCode: input.proxyCountryCode,
        enableRecording: input.enableRecording,
      }),
      ...(idleMinutes === undefined ? {} : { idleTimeoutMs: idleMinutes * 60_000 }),
      ...(hosts?.length ? { allowedHosts: hosts } : { allowedHosts: undefined }),
      ...(allowPrivate ? { allowPrivateNetwork: true } : { allowPrivateNetwork: undefined }),
    } as BrowserIntegrationConfig;

    yield* ctx.core.integrations.update(slug, {
      config: next as never,
      ...(input.name?.trim() ? { name: input.name.trim() } : {}),
    });

    // A running session was built around the settings that just changed: its
    // page-level policy was installed at connect time and its idle window was
    // computed from the old timeout. Closing it means the next call rebuilds
    // both, rather than leaving a browser enforcing a policy nobody can see.
    yield* Effect.promise(() =>
      stopRemoteBrowserSession(remoteSessionKey(ctx.owner, params.integration, params.connection)),
    );

    const overview = yield* browserOverviewEffect(ctx);
    const updated = overview.targets.find(
      (target) =>
        target.integration === params.integration && target.connection === params.connection,
    );
    if (!updated) {
      return yield* new BrowserBridgeError({
        message: `Saved, but "${params.integration}" has no connection "${params.connection}"`,
      });
    }
    return updated;
  });
}

/** Fields the caller actually sent. Absent stays absent rather than becoming undefined. */
function pickDefined<T extends Record<string, unknown>>(values: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function browserOverviewEffect(ctx: PluginCtx) {
  return Effect.gen(function* () {
    const integrations = yield* ctx.core.integrations.list();
    const browserRows = integrations.filter((integration) => integration.kind === "browser-bridge");
    const records = [] as Array<{
      readonly integration: (typeof browserRows)[number];
      readonly config: BrowserIntegrationConfig;
    }>;
    for (const integration of browserRows) {
      const record = yield* ctx.core.integrations.get(integration.slug);
      const config = record ? parseBrowserIntegrationConfig(record.config) : null;
      if (config) records.push({ integration, config });
    }

    const targets: BrowserTargetView[] = [];
    const userId = userIdFromOwner(ctx.owner);
    const localSessions = listSessionsForUser(userId);
    const localRecord = records.find((record) => record.config.provider === "local-extension");
    const localConnections = localRecord
      ? yield* ctx.connections.list({ integration: localRecord.integration.slug })
      : [];
    const integration = String(localRecord?.integration.slug || BROWSER_INTEGRATION_SLUG);
    const sessionScopedApproval =
      localRecord?.config.provider === "local-extension" &&
      localRecord.config.sessionScopedApproval === true;
    const now = Date.now();
    const seenLocal = new Set<string>();
    const localSettings = { sessionScopedApproval };

    for (const session of localSessions) {
      const connection = session.connectionName || BROWSER_CONNECTION_NAME;
      seenLocal.add(connection);
      const persisted = localConnections.find((row) => String(row.name) === connection);
      const verdict = localBridgeVerdict(session, now);
      const access = accessFromCapabilities(session.capabilities);
      targets.push({
        integration,
        name: localBrowserDisplayName(session),
        provider: "local-extension",
        connection,
        address: persisted?.address || localToolAddress(connection),
        settings: localSettings,
        state: verdict.status === "healthy" ? "live" : "stale",
        detail: `${localBrowserDisplayName(session)} ${String((session.client as { version?: string } | undefined)?.version || "connected")} connected · ${session.pending.length === 0 ? "no requests waiting" : `${session.pending.length} request${session.pending.length === 1 ? "" : "s"} waiting`}`,
        ...(access ? { access } : {}),
      });
    }

    for (const row of localConnections) {
      const connection = String(row.name);
      if (seenLocal.has(connection)) continue;
      seenLocal.add(connection);
      targets.push({
        integration,
        name: row.identityLabel || connection,
        provider: "local-extension",
        connection,
        address: row.address || localToolAddress(connection),
        settings: localSettings,
        state: "offline",
        detail: "Extension reverse session is not connected",
      });
    }

    if (seenLocal.size === 0) {
      targets.push({
        integration,
        name: "Local Chrome",
        provider: "local-extension",
        connection: BROWSER_CONNECTION_NAME,
        address: localToolAddress(BROWSER_CONNECTION_NAME),
        settings: localSettings,
        state: "offline",
        detail: "Extension reverse session is not connected",
      });
    }

    for (const record of records) {
      if (!isRemoteBrowserConfig(record.config)) continue;
      const connections = yield* ctx.connections.list({ integration: record.integration.slug });
      if (connections.length === 0) {
        targets.push({
          integration: String(record.integration.slug),
          name: record.integration.name,
          provider: record.config.provider,
          state: "needs-connection",
          detail: "Provider added; add credentials to create a callable browser target",
        });
        continue;
      }
      for (const connection of connections) {
        const key = remoteSessionKey(
          ctx.owner,
          String(record.integration.slug),
          String(connection.name),
        );
        const session = getRemoteBrowserSession(key);
        const failure = getRemoteBrowserFailure(key);
        const hostReady = remoteTargetHostReady(record.config);
        targets.push({
          integration: String(record.integration.slug),
          name: record.integration.name,
          provider: record.config.provider,
          connection: String(connection.name),
          address: connection.address,
          state: session ? "live" : failure ? "error" : hostReady ? "ready" : "offline",
          detail: session
            ? `Session ${session.sessionId} is active`
            : failure
              ? failure.detail
              : hostReady
                ? "Configured; starts on first browser call"
                : "Host authentication is missing; this target cannot start",
          ...(session ? { session: withoutSessionKey(session) } : {}),
          ...(failure ? { failure: withoutFailureKey(failure) } : {}),
          settings: settingsFor(record.config),
        });
      }
    }

    const configured = new Map<string, number>();
    for (const record of records) {
      if (record.config.provider === "local-extension") continue;
      configured.set(record.config.provider, (configured.get(record.config.provider) || 0) + 1);
    }
    return {
      providers: CLOUD_BROWSER_PROVIDERS.map((provider) => {
        const count = configured.get(provider.id) || 0;
        return {
          id: provider.id,
          name: provider.name,
          transport: provider.transport,
          ...remoteProviderAvailability(provider.id, count),
          setup: remoteProviderSetup[provider.id].setup,
          note:
            "note" in provider && provider.note
              ? provider.note
              : remoteProviderSetup[provider.id].note,
          configured: count,
          hostIdentity: provider.id === "vercel-sandbox" && hostHasVercelIdentity(),
        };
      }),
      targets,
      updatedAt: Date.now(),
    };
  });
}

function requiredText(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

function optionalNumber(
  value: number | undefined,
  label: string,
  options: { readonly min: number; readonly max?: number; readonly integer?: boolean },
): number | undefined {
  if (value === undefined) return undefined;
  if (
    !Number.isFinite(value) ||
    value < options.min ||
    (options.max !== undefined && value > options.max) ||
    (options.integer && !Number.isInteger(value))
  ) {
    const range =
      options.max === undefined ? `at least ${options.min}` : `${options.min}-${options.max}`;
    throw new Error(`${label} must be ${range}${options.integer ? " and an integer" : ""}`);
  }
  return value;
}

function browserConfigFromInput(
  input: AddBrowserProviderInput,
): Exclude<BrowserIntegrationConfig, { provider: "local-extension" }> {
  const idleMinutes = optionalNumber(input.idleTimeoutMinutes, "Idle timeout", {
    min: 1,
    max: 240,
    integer: true,
  });
  const hosts = [...new Set((input.allowedHosts || []).map(normalizeHost).filter(Boolean))];
  // Opting into private address space without naming hosts would leave a target
  // that can reach an internal network and anything else besides, which is the
  // combination this exists to prevent.
  if (input.allowPrivateNetwork && hosts.length === 0) {
    throw new Error(
      "List the hosts this target may reach before allowing private addresses. A target that can reach a private network and every public one is not bounded by anything.",
    );
  }
  const controls = {
    ...(idleMinutes === undefined ? {} : { idleTimeoutMs: idleMinutes * 60_000 }),
    ...(input.allowAdvanced === undefined ? {} : { allowAdvanced: input.allowAdvanced }),
    ...(hosts.length ? { allowedHosts: hosts } : {}),
    ...(input.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
    ...(input.fullAccess ? { fullAccess: true } : {}),
  };
  switch (input.provider) {
    case "vercel-sandbox": {
      const timeoutMs = optionalNumber(input.timeoutMs, "Session timeout", { min: 1 });
      const vcpus = optionalNumber(input.vcpus, "vCPUs", { min: 1, integer: true });
      // Token auth is the default because it is the one that works regardless
      // of where Executor is deployed. Targets created before this option
      // existed carry no `auth` and keep the ambient behaviour they were built
      // with, which is why the absent case is not treated as "token".
      const auth = input.vercelAuth ?? "token";
      return {
        provider: input.provider,
        auth,
        ...controls,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(vcpus !== undefined ? { vcpus } : {}),
        // Optional on purpose: the Sandbox SDK infers both from the token, so
        // requiring them here would reintroduce two fields the user does not
        // have to hand. Stored only when explicitly overridden.
        ...(input.teamId?.trim() ? { teamId: input.teamId.trim() } : {}),
        ...(input.projectId?.trim() ? { projectId: input.projectId.trim() } : {}),
        ...(input.image?.trim() ? { image: input.image.trim() } : {}),
      };
    }
    case "cloudflare-browser-run": {
      const keepAliveMs = optionalNumber(input.keepAliveMs, "Keep-alive", {
        min: 10_000,
        max: 1_200_000,
        integer: true,
      });
      return {
        provider: input.provider,
        // Left empty when the user did not supply one. `resolveCloudflareAccount`
        // fills it from the token before anything is stored, and refuses the add
        // if it cannot, so an empty account ID never reaches the database.
        accountId: input.accountId?.trim() || "",
        ...controls,
        ...(keepAliveMs !== undefined ? { keepAliveMs } : {}),
      };
    }
    case "browser-use": {
      const timeoutMinutes = optionalNumber(input.timeoutMinutes, "Timeout", {
        min: 1,
        max: 240,
        integer: true,
      });
      return {
        provider: input.provider,
        ...controls,
        ...(timeoutMinutes !== undefined ? { timeoutMinutes } : {}),
        ...(input.profileId ? { profileId: input.profileId.trim() } : {}),
        ...(input.proxyCountryCode !== undefined
          ? { proxyCountryCode: input.proxyCountryCode }
          : {}),
        ...(input.enableRecording !== undefined ? { enableRecording: input.enableRecording } : {}),
      };
    }
    case "generic-cdp": {
      const cdpUrl = requiredText(input.cdpUrl, "CDP URL");
      const parsed = new URL(cdpUrl);
      if (!["ws:", "wss:", "http:", "https:"].includes(parsed.protocol)) {
        throw new Error("CDP URL must use ws, wss, http, or https");
      }
      const headerName = input.authHeaderName?.trim();
      return {
        provider: input.provider,
        cdpUrl,
        ...controls,
        ...(input.liveUrl?.trim() ? { liveUrl: input.liveUrl.trim() } : {}),
        auth: headerName
          ? { kind: "header", headerName, prefix: input.authPrefix || "" }
          : { kind: "none" },
      };
    }
  }
}

/**
 * Existing connections the user could reuse for this provider.
 *
 * Returns names only. Reading a secret out of another integration is a
 * privilege move, so it happens once, on adoption, after the user picks.
 */
function reusableCredentialsEffect(
  ctx: PluginCtx,
  provider: Exclude<BrowserIntegrationConfig["provider"], "local-extension">,
) {
  return Effect.gen(function* () {
    if (REUSE_HINTS[provider].length === 0) return [] as readonly ReusableCredentialView[];
    const integrations = yield* ctx.core.integrations.list();
    const candidates = integrations.filter(
      (integration) =>
        credentialLooksReusable(provider, String(integration.slug), integration.name) &&
        !integrationIsBrowserTarget(integration),
    );
    const found: ReusableCredentialView[] = [];
    for (const integration of candidates) {
      const connections = yield* ctx.connections.list({ integration: integration.slug });
      for (const connection of connections) {
        // Connections that cannot be copied are still listed, as `mint`. They
        // are usually the MCP connection the user already set up, and hiding
        // them left the page silent about the credential most likely to be able
        // to solve the problem.
        const usage = connectionOffersReusableSecret(connection, integration) ? "copy" : "mint";
        if (usage === "mint" && !providerCanMint(provider)) continue;
        found.push({
          integration: String(integration.slug),
          integrationName: integration.name,
          connection: String(connection.name),
          address: String(connection.address),
          usage,
          ...(connection.identityLabel ? { identityLabel: connection.identityLabel } : {}),
        });
      }
    }
    return found;
  });
}

/**
 * Resolve the secret to store, either pasted or adopted from another connection.
 *
 * Adoption re-checks the same rule the picker uses, because the picker is only
 * an offer and this is the gate. Without it, a request naming any integration
 * would copy that integration's secret into a `generic-cdp` target whose auth
 * header and endpoint URL the same request supplies, which turns a
 * write-only stored credential into one that can be sent anywhere. The reuse
 * hints exclude `generic-cdp` and `vercel-sandbox` outright, so that shape is
 * unreachable rather than merely discouraged.
 */
/**
 * Create a provider token using a credential the user already holds.
 *
 * Reached only when the request names a connection to mint from, which only an
 * explicit click sets. The same `credentialLooksReusable` gate that guards
 * copying guards this too: without it a request could name any integration in
 * the catalog and have its secret used to create tokens elsewhere.
 *
 * The account must be known before minting, because the token is scoped to one
 * account and a policy needs a concrete ID. That is the one case where the
 * account cannot be inferred afterwards from the token we are about to create.
 */
function mintCredentialForNewTarget(
  ctx: PluginCtx,
  input: AddBrowserProviderInput,
  provider: Exclude<BrowserIntegrationConfig["provider"], "local-extension">,
) {
  return Effect.gen(function* () {
    if (!providerCanMint(provider)) {
      return yield* new BrowserBridgeError({
        message: `${browserProviderName(provider)} tokens cannot be created through its API. Create one in the dashboard and paste it here.`,
      });
    }
    const slug = IntegrationSlug.make(input.mintIntegration!);
    const source = yield* ctx.core.integrations.get(slug);
    if (!source || !credentialLooksReusable(provider, String(slug), source.name)) {
      return yield* new BrowserBridgeError({
        message: `"${input.mintIntegration}" is not offered as a credential source for ${browserProviderName(provider)}`,
      });
    }
    const connections = yield* ctx.connections.list({ integration: slug });
    const row = connections.find((candidate) => String(candidate.name) === input.mintConnection);
    if (!row) {
      return yield* new BrowserBridgeError({
        message: `No connection "${input.mintConnection}" on "${input.mintIntegration}"`,
      });
    }
    const label = `${input.name?.trim() || "Executor browser"}`;

    // An MCP connection's credential does not authenticate to the provider's
    // REST API, so it cannot mint from this process at all. The authority the
    // user granted lives behind the MCP server, and `execute` is how it is
    // reached. `ctx.execute` keeps policy, approval, and credential resolution
    // in the core path rather than reaching around them.
    if (source.kind === "mcp") {
      const accountId = input.accountId?.trim();
      const script = cloudflareMintScript({
        // Cloudflare's own `execute` tool pre-binds `accountId`, so an empty
        // one here resolves inside the sandbox to the account the MCP grant is
        // already scoped to, which is the account the user means.
        accountId: accountId || "",
        label,
      });
      const raw = yield* ctx
        .execute(ToolAddress.make(`${String(row.address)}.execute`), { code: script })
        .pipe(
          Effect.mapError((error) =>
            browserBridgeError(error, `Could not run "execute" on "${input.mintIntegration}"`),
          ),
        );
      const outcome = readMintScriptResult(raw);
      if (!outcome.ok) return yield* new BrowserBridgeError({ message: outcome.detail });
      return { token: outcome.token, accountId: outcome.accountId || accountId || "" };
    }

    const existing = yield* ctx.connections.resolveValue({
      owner: row.owner,
      integration: row.integration,
      name: row.name,
    });
    if (!existing) {
      return yield* new BrowserBridgeError({
        message: `"${input.mintConnection}" holds no value this plugin can read`,
      });
    }

    const accountId =
      input.accountId?.trim() ||
      (yield* Effect.promise(() => inferCloudflareAccountId(existing)).pipe(
        Effect.map((found) => ("accountId" in found ? found.accountId : "")),
      ));
    if (!accountId) {
      return yield* new BrowserBridgeError({
        message:
          "Could not work out which Cloudflare account to scope the new token to. Enter the account ID and try again.",
      });
    }

    const minted = yield* Effect.promise(() =>
      mintCloudflareBrowserToken({ token: existing, accountId, label }),
    );
    if (!minted.ok) return yield* new BrowserBridgeError({ message: minted.detail });
    return { token: minted.token, accountId: minted.accountId || accountId };
  });
}

function credentialForNewTarget(
  ctx: PluginCtx,
  input: AddBrowserProviderInput,
  provider: Exclude<BrowserIntegrationConfig["provider"], "local-extension">,
) {
  return Effect.gen(function* () {
    const pasted = input.credential?.trim();
    if (pasted) return { credential: pasted, accountId: "" };
    // A minted token reports the account it was scoped to. That is the only
    // way to learn it: the token carries Browser Rendering and nothing else,
    // so asking Cloudflare which accounts it can see comes back empty.
    if (input.mintIntegration && input.mintConnection) {
      const minted = yield* mintCredentialForNewTarget(ctx, input, provider);
      return { credential: minted.token, accountId: minted.accountId };
    }
    if (!input.reuseIntegration || !input.reuseConnection) {
      return { credential: "", accountId: "" };
    }
    const slug = IntegrationSlug.make(input.reuseIntegration);
    const source = yield* ctx.core.integrations.get(slug);
    if (!source || !credentialLooksReusable(provider, String(slug), source.name)) {
      return yield* new BrowserBridgeError({
        message: `"${input.reuseIntegration}" is not offered as a credential source for ${browserProviderName(provider)}`,
      });
    }
    const connections = yield* ctx.connections.list({ integration: slug });
    const row = connections.find((candidate) => String(candidate.name) === input.reuseConnection);
    if (!row) {
      return yield* new BrowserBridgeError({
        message: `No connection "${input.reuseConnection}" on "${input.reuseIntegration}" to reuse`,
      });
    }
    const value = yield* ctx.connections.resolveValue({
      owner: row.owner,
      integration: row.integration,
      name: row.name,
    });
    if (!value) {
      return yield* new BrowserBridgeError({
        message: `"${input.reuseConnection}" holds no value this plugin can read; paste a credential instead`,
      });
    }
    return { credential: value, accountId: "" };
  });
}

/**
 * Supply the Cloudflare account ID from the token when the user left it blank.
 *
 * Only the single-account case is inferred. When a token spans several accounts
 * there is no safe default, and the error says which choice is missing rather
 * than letting the target be built around a guess.
 */
function resolveCloudflareAccount<
  T extends { readonly provider: string; readonly accountId?: string },
>(config: T, credential: string | null) {
  return Effect.gen(function* () {
    if (config.provider !== "cloudflare-browser-run" || config.accountId || !credential) {
      return config;
    }
    const found = yield* Effect.promise(() => inferCloudflareAccountId(credential));
    if ("accountId" in found) return { ...config, accountId: found.accountId };
    return yield* new BrowserBridgeError({
      message:
        found.reason === "ambiguous"
          ? "This token can reach more than one Cloudflare account. Enter the account ID for the one to use."
          : found.reason === "none"
            ? "This token can reach no Cloudflare account. Check the token, or enter the account ID."
            : "Could not read the account for this token. Enter the Cloudflare account ID.",
    });
  });
}

function addBrowserProviderEffect(ctx: PluginCtx, input: AddBrowserProviderInput) {
  return Effect.gen(function* () {
    const config = yield* Effect.try({
      try: () => browserConfigFromInput(input),
      catch: (error) => browserBridgeError(error, "Invalid browser provider configuration"),
    });
    const requestedSlug = input.slug?.trim();
    const baseSlug = (
      {
        "vercel-sandbox": "browser-vercel",
        "cloudflare-browser-run": "browser-cloudflare",
        "browser-use": "browser-use",
        "generic-cdp": "browser-cdp",
      } as const
    )[config.provider];
    let slug = IntegrationSlug.make(requestedSlug || baseSlug);
    let existing = yield* ctx.core.integrations.get(slug);
    if (requestedSlug && existing) {
      return yield* new BrowserBridgeError({
        message: `Integration "${String(slug)}" already exists`,
      });
    }
    let suffix = 2;
    while (existing) {
      slug = IntegrationSlug.make(`${baseSlug}-${suffix}`);
      existing = yield* ctx.core.integrations.get(slug);
      suffix += 1;
    }

    const secretRequired =
      config.provider === "cloudflare-browser-run" ||
      config.provider === "browser-use" ||
      (config.provider === "vercel-sandbox" && config.auth === "token") ||
      (config.provider === "generic-cdp" && config.auth?.kind === "header");
    const { credential, accountId: mintedAccount } = yield* credentialForNewTarget(
      ctx,
      input,
      config.provider,
    );
    if (secretRequired && !credential) {
      return yield* new BrowserBridgeError({ message: "Provider credential is required" });
    }

    // Fill in the Cloudflare account from the token when the user left it
    // blank, so a pasted token is enough. Deliberately after the credential is
    // resolved and before the probe, since the probe reads the account too and
    // would otherwise fail on the empty ID we are about to supply. A minted
    // token brings its own account, which is taken directly: inferring it
    // would mean asking a Browser-Rendering-only token to list accounts.
    const named =
      mintedAccount && config.provider === "cloudflare-browser-run" && !config.accountId
        ? { ...config, accountId: mintedAccount }
        : config;
    const resolved = yield* resolveCloudflareAccount(named, credential);

    // Check the credential before writing anything. A target created around a
    // rejected token looks configured and fails only at the first browser call,
    // which is exactly the false-green this refuses to create. Transport
    // failures are not treated as proof of a bad credential.
    const probe = yield* Effect.promise(() =>
      probeProvider(probeTargetFor(resolved), credential || null),
    );
    if (!probe.ok && (probe.reason === "auth" || probe.reason === "permission")) {
      return yield* new BrowserBridgeError({ message: `${probe.detail}. ${probe.hint}` });
    }

    const name = input.name?.trim() || browserProviderName(config.provider);
    yield* ctx.core.integrations.register({
      slug,
      name,
      // `resolved`, not `config`: an inferred account ID has to be the one
      // stored, or every session start would infer it again.
      description: remoteProviderSetup[config.provider].note,
      config: resolved,
      canRemove: true,
      canRefresh: true,
    });
    const template =
      config.provider === "cloudflare-browser-run" ||
      (config.provider === "vercel-sandbox" && config.auth === "token")
        ? "api-token"
        : config.provider === "browser-use"
          ? "api-key"
          : config.provider === "generic-cdp" && config.auth?.kind === "header"
            ? "header"
            : "none";
    const connectionName = ConnectionName.make(input.connectionName?.trim() || "default");
    // An integration with no connection is not a browser target, it is a name
    // that blocks the slug and cannot be called. If the credential fails to
    // persist, take the integration back out rather than leaving the user to
    // discover the orphan when their retry reports "already exists".
    const connection = yield* ctx.connections
      .create({
        owner: "user",
        name: connectionName,
        integration: slug,
        template: AuthTemplateSlug.make(template),
        value: credential,
        description: `${name} browser target`,
      })
      .pipe(
        Effect.tapError(() => ctx.core.integrations.remove(slug).pipe(Effect.ignore)),
        Effect.tapDefect(() => ctx.core.integrations.remove(slug).pipe(Effect.ignore)),
      );
    const overview = yield* browserOverviewEffect(ctx);
    return overview.targets.find(
      (target) =>
        target.integration === String(slug) && target.connection === String(connection.name),
    )!;
  });
}

/**
 * Check one target on demand: the reverse session for local Chrome, the stored
 * credential for a remote provider. Unlike `checkHealth` this always contacts
 * the provider, because the user asked for the check, a live session proves
 * the target works but not that the credential is still good.
 */
/** The page a trial run loads. Stable, tiny, and nobody's private property. */
const TRIAL_URL = "https://example.com/";

/**
 * Drive the browser once, for real.
 *
 * The credential probe cannot answer "will this browse?": for Vercel it stops
 * at "token accepted, entitlement not confirmed", because entitlement is not
 * readable from the API. The only way to know is to start one, and the only
 * honest way to offer that is as a separate, explicit action, since it costs a
 * session.
 *
 * The session is stopped on the way out, including after a failure, so a failed
 * trial cannot leave a sandbox running until the idle reaper finds it.
 */
function trialRunEffect(ctx: PluginCtx, integration: string, connection: string) {
  return Effect.gen(function* () {
    const slug = IntegrationSlug.make(integration);
    const record = yield* ctx.core.integrations.get(slug);
    const config = record ? parseBrowserIntegrationConfig(record.config) : null;
    if (!config || !isRemoteBrowserConfig(config)) {
      return yield* new BrowserBridgeError({
        message: `"${integration}" is not a remote browser target`,
      });
    }
    const connections = yield* ctx.connections.list({ integration: slug });
    const row = connections.find((candidate) => String(candidate.name) === connection);
    if (!row) {
      return yield* new BrowserBridgeError({
        message: `"${integration}" has no connection named "${connection}"`,
      });
    }
    const credential = yield* ctx.connections.resolveValue({
      owner: row.owner,
      integration: row.integration,
      name: row.name,
    });

    const key = remoteSessionKey(ctx.owner, integration, connection);
    const startedAt = Date.now();
    const outcome = yield* Effect.promise(async () => {
      try {
        const result = (await runRemoteBrowserTool({
          key,
          config,
          credential,
          tool: "navigate",
          args: { url: TRIAL_URL },
        })) as { readonly tab?: { readonly title?: string; readonly url?: string } };
        return { ok: true as const, tab: result?.tab };
      } catch (error) {
        return { ok: false as const, error };
      } finally {
        // A failure to stop must not replace the trial's own verdict, which is
        // the thing the user asked for.
        try {
          await stopRemoteBrowserSession(key);
        } catch {
          /* left to the idle reaper */
        }
      }
    });
    const ms = Date.now() - startedAt;
    const ranAt = Date.now();

    if (outcome.ok) {
      return {
        ok: true,
        detail: `${browserProviderName(config.provider)} started a browser and loaded a page in ${Math.round(ms / 1000)}s`,
        ...(outcome.tab?.title ? { title: outcome.tab.title } : {}),
        ...(outcome.tab?.url ? { url: outcome.tab.url } : {}),
        ms,
        ranAt,
      };
    }
    // Reuse the start-failure classifier so a trial explains itself the same
    // way a failed session does, rather than inventing a second vocabulary.
    const failure = classifyRemoteBrowserFailure(key, config.provider, outcome.error);
    return { ok: false, detail: failure.detail, hint: failure.hint, ms, ranAt };
  });
}

function testBrowserConnectionEffect(ctx: PluginCtx, integration: string, connection: string) {
  return Effect.gen(function* () {
    const slug = IntegrationSlug.make(integration);
    const record = yield* ctx.core.integrations.get(slug);
    const config = record ? parseBrowserIntegrationConfig(record.config) : null;
    if (!config) {
      return yield* new BrowserBridgeError({
        message: `"${integration}" is not a browser target`,
      });
    }
    const checkedAt = Date.now();

    if (!isRemoteBrowserConfig(config)) {
      const verdict = localBridgeVerdict(
        findSessionForConnection(userIdFromOwner(ctx.owner), connection),
        checkedAt,
      );
      return verdict.status === "healthy"
        ? { ok: true, detail: verdict.detail, verified: true, checkedAt }
        : {
            ok: false,
            // The credential is not the problem: the browser at the other end
            // of the bridge is not there.
            reason: "host" as const,
            detail: verdict.detail,
            hint: "Open the Executor Browser side panel and press Connect.",
            verified: false,
            checkedAt,
          };
    }

    const connections = yield* ctx.connections.list({ integration: slug });
    const row = connections.find((candidate) => String(candidate.name) === connection);
    if (!row) {
      return yield* new BrowserBridgeError({
        message: `"${integration}" has no connection named "${connection}"`,
      });
    }
    const credential = yield* ctx.connections.resolveValue({
      owner: row.owner,
      integration: row.integration,
      name: row.name,
    });
    const probe = yield* Effect.promise(() => probeProvider(probeTargetFor(config), credential));
    return connectionTestFromProbe(probe, browserProviderName(config.provider), checkedAt);
  });
}

/**
 * Take a browser target out of the catalog: session, connection, integration.
 *
 * A target is one integration+connection created by addProvider, so removal
 * walks the same shape backwards, any live session is stopped first (a
 * removed target must not leave a provider VM running on the clock), and the
 * integration goes once its last connection is gone, because an integration
 * with no connection is just a name squatting on the slug.
 */
function removeBrowserTargetEffect(ctx: PluginCtx, integration: string, connection: string) {
  return Effect.gen(function* () {
    const slug = IntegrationSlug.make(integration);
    const record = yield* ctx.core.integrations.get(slug);
    const config = record ? parseBrowserIntegrationConfig(record.config) : null;
    if (!config) {
      return yield* new BrowserBridgeError({
        message: `"${integration}" is not a browser target`,
      });
    }
    yield* Effect.promise(() =>
      stopRemoteBrowserSession(remoteSessionKey(ctx.owner, integration, connection)).then(
        () => undefined,
      ),
    );
    const rows = yield* ctx.connections.list({ integration: slug });
    const row = rows.find((candidate) => String(candidate.name) === connection);
    if (row) {
      yield* ctx.connections.remove({
        owner: row.owner,
        integration: row.integration,
        name: row.name,
      });
    }
    const remaining = yield* ctx.connections.list({ integration: slug });
    if (remaining.length === 0) {
      yield* ctx.core.integrations.remove(slug);
    }
    return { removed: true };
  });
}

const makeBrowserBridgeExtension = (ctx: PluginCtx) => ({
  ensureChrome: () => ensureChromeEffect(ctx),
  overview: () => browserOverviewEffect(ctx),
  addProvider: (input: AddBrowserProviderInput) => addBrowserProviderEffect(ctx, input),
  removeTarget: (integration: string, connection: string) =>
    removeBrowserTargetEffect(ctx, integration, connection),
  updateTarget: (
    params: { readonly integration: string; readonly connection: string },
    input: UpdateBrowserTargetPayload,
  ) => updateTargetEffect(ctx, params, input),
  reusableCredentials: (
    provider: Exclude<BrowserIntegrationConfig["provider"], "local-extension">,
  ) => reusableCredentialsEffect(ctx, provider),
  testConnection: (integration: string, connection: string) =>
    testBrowserConnectionEffect(ctx, integration, connection),
  trialRun: (integration: string, connection: string) =>
    trialRunEffect(ctx, integration, connection),
  stopSession: (integration: string, connection: string) =>
    Effect.promise(() =>
      stopRemoteBrowserSession(remoteSessionKey(ctx.owner, integration, connection)).then(
        (stopped) => ({ stopped }),
      ),
    ),
});

export type BrowserBridgePluginExtension = ReturnType<typeof makeBrowserBridgeExtension>;

export class BrowserBridgeExtensionService extends Context.Service<
  BrowserBridgeExtensionService,
  BrowserBridgePluginExtension
>()("BrowserBridgeExtensionService") {}

const BrowserControlApiBundle = HttpApi.make("browser-control").add(BrowserControlApi);

const BrowserControlHandlers = HttpApiBuilder.group(
  BrowserControlApiBundle,
  "browserControl",
  (handlers) =>
    handlers
      .handle("overview", () =>
        Effect.gen(function* () {
          const extension = yield* BrowserBridgeExtensionService;
          return yield* extension.overview();
        }).pipe(
          Effect.mapError((error) => browserBridgeError(error, "Could not load browsers").message),
        ),
      )
      .handle("addProvider", ({ payload }) =>
        Effect.gen(function* () {
          const extension = yield* BrowserBridgeExtensionService;
          return yield* extension.addProvider(payload);
        }).pipe(
          Effect.mapError((error) => browserBridgeError(error, "Could not add browser").message),
        ),
      )
      .handle("updateTarget", ({ params, payload }) =>
        Effect.gen(function* () {
          const extension = yield* BrowserBridgeExtensionService;
          return yield* extension.updateTarget(params, payload);
        }).pipe(
          Effect.mapError(
            (error) => browserBridgeError(error, "Could not save these settings").message,
          ),
        ),
      )
      .handle("stopSession", ({ params }) =>
        Effect.gen(function* () {
          const extension = yield* BrowserBridgeExtensionService;
          return yield* extension.stopSession(params.integration, params.connection);
        }).pipe(
          Effect.mapError((error) => browserBridgeError(error, "Could not stop browser").message),
        ),
      )
      .handle("removeTarget", ({ params }) =>
        Effect.gen(function* () {
          const extension = yield* BrowserBridgeExtensionService;
          return yield* extension.removeTarget(params.integration, params.connection);
        }).pipe(
          Effect.mapError(
            (error) => browserBridgeError(error, "Could not remove this browser").message,
          ),
        ),
      )
      .handle("reusableCredentials", ({ params }) =>
        Effect.gen(function* () {
          const extension = yield* BrowserBridgeExtensionService;
          return yield* extension.reusableCredentials(params.provider);
        }).pipe(
          Effect.mapError(
            (error) => browserBridgeError(error, "Could not list existing credentials").message,
          ),
        ),
      )
      .handle("trialRun", ({ params }) =>
        Effect.gen(function* () {
          const extension = yield* BrowserBridgeExtensionService;
          return yield* extension.trialRun(params.integration, params.connection);
        }).pipe(
          Effect.mapError(
            (error) => browserBridgeError(error, "Could not run the browser").message,
          ),
        ),
      )
      .handle("testConnection", ({ params }) =>
        Effect.gen(function* () {
          const extension = yield* BrowserBridgeExtensionService;
          return yield* extension.testConnection(params.integration, params.connection);
        }).pipe(
          Effect.mapError(
            (error) => browserBridgeError(error, "Could not test this browser").message,
          ),
        ),
      ),
);

async function runTool(
  userId: string,
  toolName: string,
  args: Record<string, unknown> | undefined,
  timeoutMs: number,
  caller?: { name: string; version?: string } | null,
  connectionName?: string,
): Promise<unknown> {
  const name = browserToolNameFromCatalog(toolName) || toolName;
  // The client name is whatever the client said it was. `principal` is what
  // this request actually authenticated as, so the extension can show the
  // difference instead of presenting a claim as an identity.
  const attributed = { name: caller?.name || "unknown", ...caller, principal: userId };

  if (name === "status") {
    const sessions = listSessionsForUser(userId).map(sessionPublicView);
    const self =
      (connectionName && sessions.find((session) => session.connection === connectionName)) ||
      sessions[0];
    return {
      this: self
        ? {
            connection: self.connection,
            address: self.address,
            ...(self.label ? { label: self.label } : {}),
            ...(self.browser ? { browser: self.browser } : {}),
          }
        : connectionName
          ? { connection: connectionName, address: localToolAddress(connectionName) }
          : null,
      browsers: sessions.map((session) => ({
        connection: session.connection,
        address: session.address,
        ...(session.label ? { label: session.label } : {}),
        ...(session.browser ? { browser: session.browser } : {}),
        lastSeenAt: session.lastSeenAt,
        pending: session.pending,
      })),
      sessions,
      live: Boolean(self),
      extension: self?.client ?? null,
      tools: (self?.capabilities as { tools?: string[] } | undefined)?.tools ?? [],
      pendingJobs: self?.pending ?? 0,
      note:
        sessions.length === 0
          ? "No live reverse session. Open Executor Browser → Connect (path B)."
          : sessions.length === 1
            ? `One local browser live: ${self?.label || self?.browser || self?.connection} at ${self?.address}.`
            : `Multiple local browsers are connected. Use the matching tools.browser.user.<connection> prefix. This call is ${self?.address || localToolAddress(connectionName || DEFAULT_LOCAL_CONNECTION)}. Also live: ${sessions
                .map((session) => session.address)
                .join(", ")}.`,
    };
  }
  if (name === "call") {
    const body = args || {};
    const timeoutOverride =
      typeof body.timeoutMs === "number" && Number.isFinite(body.timeoutMs)
        ? body.timeoutMs
        : timeoutMs;
    const validated = validateInnerCall(body.tool, body.args);
    return callTool({
      userId,
      tool: validated.tool,
      args: validated.args,
      connection: connectionName,
      sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
      timeoutMs: timeoutOverride,
      caller: attributed,
    });
  }
  const validated = validateInnerCall(name, args || {});
  return callTool({
    userId,
    tool: validated.tool,
    args: validated.args,
    connection: connectionName,
    timeoutMs,
    caller: attributed,
  });
}

function ensureLocalConnectionEffect(
  ctx: PluginCtx,
  slug: ReturnType<typeof IntegrationSlug.make>,
  connectionName: string,
  identityLabel: string,
) {
  const name = ConnectionName.make(connectionName);
  const description = `Local browser via Executor Browser. Agents call ${localToolAddress(connectionName)}.`;
  const ref = { owner: "user" as const, integration: slug, name };
  return Effect.gen(function* () {
    const created = yield* ctx.connections
      .create({
        owner: "user",
        name,
        integration: slug,
        template: AuthTemplateSlug.make("none"),
        value: "",
        identityLabel,
        description,
      })
      .pipe(
        Effect.map(() => true),
        Effect.catch(() => Effect.succeed(false)),
      );
    if (!created) {
      yield* ctx.connections
        .update(ref, { identityLabel, description })
        .pipe(Effect.catch(() => Effect.void));
    }
    yield* ctx.connections.refresh(ref).pipe(Effect.catch(() => Effect.void));
    return created;
  });
}

function ensureChromeEffect(ctx: PluginCtx) {
  const slug = IntegrationSlug.make(BROWSER_INTEGRATION_SLUG);
  return Effect.gen(function* () {
    yield* ctx.core.integrations.register({
      slug,
      name: "Local browsers",
      description:
        "Real browsers via the Executor Browser extension reverse channel (path B). Each connected browser is its own connection (tools.browser.user.<name>). No companion process required.",
      config: LOCAL_BROWSER_CONFIG,
      canRemove: true,
      canRefresh: true,
    });

    const sessions = listSessionsForUser(userIdFromOwner(ctx.owner));
    const toEnsure: Array<{
      readonly connectionName: string;
      readonly identityLabel: string;
      readonly browser?: string;
      readonly label?: string;
    }> =
      sessions.length > 0
        ? sessions.map((session) => ({
            connectionName: session.connectionName,
            identityLabel: localBrowserDisplayName(session),
            ...(session.browser ? { browser: session.browser } : {}),
            ...(session.label ? { label: session.label } : {}),
          }))
        : [
            {
              connectionName: BROWSER_CONNECTION_NAME,
              identityLabel: "Local Chrome",
            },
          ];

    let createdAny = false;
    for (const target of toEnsure) {
      const created = yield* ensureLocalConnectionEffect(
        ctx,
        slug,
        target.connectionName,
        target.identityLabel,
      );
      createdAny = createdAny || created;
    }

    const primary = toEnsure[0]!;
    return {
      ok: true,
      integration: BROWSER_INTEGRATION_SLUG,
      connection: primary.connectionName,
      address: localToolAddress(primary.connectionName),
      connections: toEnsure.map((target) => ({
        connection: target.connectionName,
        address: localToolAddress(target.connectionName),
        ...(target.label ? { label: target.label } : {}),
        ...(target.browser ? { browser: target.browser } : {}),
      })),
      note: createdAny
        ? `Browser connection created.${sessions.length ? " Reverse session live." : " Connect extension for green status."}`
        : `Browser connection ensured.${sessions.length ? ` ${sessions.length} reverse session${sessions.length === 1 ? "" : "s"} live.` : " Connect extension for green status."}`,
    };
  });
}

export const browserBridgePlugin = definePlugin((options: BrowserBridgePluginOptions = {}) => {
  const defaultTimeout = options.callTimeoutMs ?? 45_000;

  return {
    id: "browser-bridge" as const,
    packageName: "@executor-js/plugin-browser-bridge",
    storage: () => ({}),

    integrationPresets: [
      {
        id: BROWSER_INTEGRATION_SLUG,
        name: "Local browsers",
        summary:
          "Drive connected Chrome, Brave, or Edge via the extension reverse channel (path B). Each browser is tools.browser.user.<connection>.",
        featured: true,
      },
    ],

    describeAuthMethods: (integration) => {
      const config = parseBrowserIntegrationConfig(integration.config);
      return config ? browserAuthMethods(config) : [];
    },

    describeIntegrationDisplay: (integration) => {
      const config = parseBrowserIntegrationConfig(integration.config);
      return {
        family: "browser",
        ...(config?.provider === "generic-cdp" ? { url: config.liveUrl || config.cdpUrl } : {}),
      };
    },

    remoteToolCatalog: false,
    resolveTools: ({ config, connection, ctx }) => {
      const parsed = parseBrowserIntegrationConfig(config);
      if (isRemoteBrowserConfig(parsed)) {
        return Effect.succeed(remoteCatalogResult(parsed));
      }
      const connectionName = String(connection.name);
      const session = ctx
        ? findSessionForConnection(userIdFromOwner(ctx.owner), connectionName)
        : undefined;
      return Effect.succeed(
        catalogResult(parsed, {
          connectionName,
          label: session ? localBrowserDisplayName(session) : connectionName,
        }),
      );
    },
    validateToolArgs: ({ toolRow, args }) =>
      Effect.try({
        try: () => {
          const name = String(toolRow.name);
          if (name.startsWith("session_")) return;
          validateInnerCall(browserToolNameFromCatalog(name) || name, args || {});
        },
        catch: (error) => browserBridgeError(error, "Invalid browser tool arguments"),
      }),
    invokeTool: ({ toolRow, credential, args, ctx }) =>
      Effect.gen(function* () {
        const caller = yield* Effect.service(toolCallerRef);
        const config = parseBrowserIntegrationConfig(credential.config);
        if (!config) {
          return yield* new BrowserBridgeError({
            message: `Browser integration "${toolRow.integration}" has invalid config`,
          });
        }
        if (isRemoteBrowserConfig(config)) {
          const key = remoteSessionKey(
            ctx.owner,
            String(credential.integration),
            String(credential.connection),
          );
          const name = String(toolRow.name);
          if (name === "session_status") {
            // Reported as a shape rather than as `null`. A bare null cannot say
            // whether nothing is running or whether this looked somewhere the
            // session is not, and the caller has no way to tell those apart or
            // to report which it saw.
            const session = getRemoteBrowserSession(key);
            return session
              ? // The live-view link is withheld here and shown in the UI
                // instead. It drives the running browser on its own, so handing
                // it to a model puts a working handle on the session into a
                // transcript that outlives the approval that created it.
                { active: true as const, ...withoutLiveLinks(session) }
              : {
                  active: false as const,
                  key,
                  detail:
                    "No remote browser session is open for this connection. Any browser tool starts one, or use session_start.",
                };
          }
          if (name === "session_start") {
            return yield* Effect.tryPromise({
              try: () =>
                startRemoteBrowserSession(key, config, credential.value).then(withoutLiveLinks),
              catch: (error) => browserBridgeError(error, "Could not start remote browser"),
            });
          }
          if (name === "session_stop") {
            return yield* Effect.tryPromise({
              // Reported as stopped either way. Nothing running is the state the
              // caller asked for, and a crash-recovery path that has to guess
              // whether "false" meant failure will guess wrong.
              try: () => stopRemoteBrowserSession(key).then((stopped) => ({ ok: true, stopped })),
              catch: (error) => browserBridgeError(error, "Could not stop remote browser"),
            });
          }
          const validated = yield* Effect.try({
            try: () => validateInnerCall(browserToolNameFromCatalog(name) || name, args || {}),
            catch: (error) => browserBridgeError(error, "Invalid browser tool arguments"),
          });
          // The catalog already withholds these, so reaching here means a call
          // by name against a target that disallows them.
          if (isAdvancedBrowserTool(validated.tool) && !remoteAdvancedAllowed(config)) {
            return yield* new BrowserBridgeError({
              message: `Advanced browser tools are turned off for this target, so "${validated.tool}" is not available`,
            });
          }
          return yield* Effect.tryPromise({
            try: () =>
              runRemoteBrowserTool({
                key,
                config,
                credential: credential.value,
                tool: validated.tool,
                args: validated.args as never,
              }),
            catch: (error) => browserBridgeError(error, "Remote browser tool failed"),
          });
        }
        const localName = String(toolRow.name);
        const connectionName = String(credential.connection);
        if (localName === "session_status") {
          return localSessionStatus(ctx, connectionName);
        }
        // The catalog dropped the per-action prompts on the understanding that
        // the extension is holding this to a set of hosts. That understanding
        // is checked here, where the extension's mode is live, rather than
        // trusted from a catalog built at some earlier point.
        const scopeProblem = localScopeProblem(config, ctx, localName, connectionName);
        if (scopeProblem) return yield* new BrowserBridgeError({ message: scopeProblem });
        if (localName === "session_stop") {
          // Ending a control session only ever reduces what this can reach, so
          // an agent may do it. Starting one is the opposite and is not offered:
          // the human granting access is the point of that step.
          return yield* Effect.tryPromise({
            try: () =>
              runTool(
                userIdFromOwner(ctx.owner),
                "session.stop",
                {},
                defaultTimeout,
                caller,
                connectionName,
              ).then(() => ({ ok: true, stopped: true })),
            catch: (error) => browserBridgeError(error, "Could not end the control session"),
          });
        }
        return yield* Effect.tryPromise({
          try: () =>
            runTool(
              userIdFromOwner(ctx.owner),
              localName,
              (args || {}) as Record<string, unknown>,
              defaultTimeout,
              caller,
              connectionName,
            ),
          catch: (error) => browserBridgeError(error, "Local browser tool failed"),
        });
      }),

    checkHealth: ({ ctx, integration, credential }) =>
      Effect.gen(function* () {
        const config = parseBrowserIntegrationConfig(integration.config);
        if (isRemoteBrowserConfig(config)) {
          const key = remoteSessionKey(
            ctx.owner,
            String(credential.integration),
            String(credential.connection),
          );
          const live = getRemoteBrowserSession(key);
          const name = browserProviderName(config.provider);
          // A live session is its own proof; only probe when idle, so health
          // checks never add provider calls on top of active usage.
          if (live) {
            return {
              status: "healthy" as const,
              checkedAt: Date.now(),
              detail: `${name} session ${live.sessionId} is active`,
            };
          }
          const probe = yield* Effect.promise(() =>
            probeProvider(probeTargetFor(config), credential.value),
          );
          return {
            status: probeToHealthStatus(probe),
            checkedAt: Date.now(),
            detail: probe.ok
              ? `${name}: ${probe.detail}${probe.permissionVerified ? "" : " (session starts on demand)"}`
              : `${name}: ${probe.detail}. ${probe.hint}`,
          };
        }
        // HealthStatus vocab: healthy | expired | degraded | unknown.
        const checkedAt = Date.now();
        const verdict = localBridgeVerdict(
          findSessionForConnection(userIdFromOwner(ctx.owner), String(credential.connection)),
          checkedAt,
        );
        return { status: verdict.status, checkedAt, detail: verdict.detail };
      }),

    removeConnection: ({ ctx, integration, connection }) =>
      Effect.promise(() =>
        stopRemoteBrowserSession(
          remoteSessionKey(ctx.owner, String(integration), String(connection.name)),
        ).then(() => undefined),
      ),

    close: () => Effect.promise(stopAllRemoteBrowserSessions),

    extension: makeBrowserBridgeExtension,

    routes: () => BrowserControlApi,
    handlers: () => BrowserControlHandlers,
    extensionService: BrowserBridgeExtensionService,

    // Only installer under executor, do NOT also declare static id "browser"
    // (that duplicated the catalog row with no health dot).
    staticIntegrations: (self) => [
      {
        id: "browserBridge",
        kind: "executor" as const,
        name: "Browser bridge",
        tools: [
          tool({
            name: "ensureChrome",
            description:
              "Create local Executor Browser integration connections for every connected extension (tools.browser.user.<connection>).",
            outputSchema: InstallOutputStd,
            execute: () => self.ensureChrome(),
          }),
        ],
      },
    ],
  };
});
