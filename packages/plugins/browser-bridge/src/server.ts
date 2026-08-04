/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor, executor/no-switch-statement, executor/no-instanceof-error, executor/no-unknown-error-message -- plugin boundary normalizes schema, storage, and remote browser failures */

/**
 * Chrome desktop reverse channel (path B).
 *
 * One catalog entry only: DB integration `browser` + connection `desktop`
 * (created by ensureChrome). No static `browser` integration — that duplicated
 * the row in the UI with no status dot.
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
  type StaticToolSchema,
  type PluginCtx,
  type ResolveToolsResult,
  type ToolDef,
  toolCallerRef,
} from "@executor-js/sdk/core";

import { callTool, listSessionsForUser, sessionPublicView } from "./store";
import {
  BROWSER_TOOL_DEFINITIONS,
  BROWSER_TOOL_NAMES,
  browserToolCatalogName,
  browserToolNameFromCatalog,
  validateBrowserToolCall,
  type BrowserToolName,
} from "./protocol";
import {
  browserAuthMethods,
  browserProviderName,
  LOCAL_BROWSER_CONFIG,
  parseBrowserIntegrationConfig,
  type BrowserIntegrationConfig,
} from "./integration-config";
import { CLOUD_BROWSER_PROVIDERS } from "./cloud-providers";
import {
  getRemoteBrowserSession,
  listRemoteBrowserSessions,
  runRemoteBrowserTool,
  startRemoteBrowserSession,
  stopAllRemoteBrowserSessions,
  stopRemoteBrowserSession,
} from "./remote-runtime";
import { BrowserControlApi, type AddBrowserProviderInput } from "./shared";

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertHttpUrl(url: unknown, field = "url"): string {
  if (typeof url !== "string" || !url.trim()) throw new Error(`${field} is required`);
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${field} must use http or https`);
  }
  return url;
}

function assertOptionalTabId(args: Record<string, unknown>): void {
  if (args.tabId === undefined) return;
  if (typeof args.tabId !== "number" || !Number.isInteger(args.tabId) || args.tabId < 0) {
    throw new Error("tabId must be a non-negative integer");
  }
}

/**
 * Validate generic `call` payload so it cannot bypass per-tool input rules.
 * Returns normalized { tool, args } for the reverse bridge.
 */
export function validateInnerCallV1(
  toolRaw: unknown,
  argsRaw: unknown,
): { tool: InnerBrowserTool; args: Record<string, unknown> } {
  const tool = String(toolRaw || "");
  if (!(INNER_BROWSER_TOOLS as readonly string[]).includes(tool)) {
    throw new Error(
      `Unknown or disallowed tool "${tool}". Use one of: ${INNER_BROWSER_TOOLS.join(", ")}`,
    );
  }
  const args = argsRaw === undefined || argsRaw === null ? {} : argsRaw;
  if (!isPlainObject(args)) {
    throw new Error("args must be an object");
  }
  // Reject unexpected top-level keys per tool (defense in depth)
  const only = (allowed: string[]) => {
    for (const key of Object.keys(args)) {
      if (!allowed.includes(key)) {
        throw new Error(`Unexpected arg "${key}" for ${tool}`);
      }
    }
  };

  const normalizedTool = tool as InnerBrowserTool;
  switch (normalizedTool) {
    case "ping":
    case "tabs.list":
      only([]);
      return { tool: normalizedTool, args: {} };
    case "snapshot":
    case "screenshot":
      only(["tabId"]);
      assertOptionalTabId(args);
      return { tool: normalizedTool, args: args.tabId === undefined ? {} : { tabId: args.tabId } };
    case "tabs.open": {
      only(["url", "active"]);
      const url = assertHttpUrl(args.url);
      const out: Record<string, unknown> = { url };
      if (args.active !== undefined) {
        if (typeof args.active !== "boolean") throw new Error("active must be boolean");
        out.active = args.active;
      }
      return { tool: normalizedTool, args: out };
    }
    case "navigate": {
      only(["tabId", "url", "newTab"]);
      assertOptionalTabId(args);
      const url = assertHttpUrl(args.url);
      const out: Record<string, unknown> = { url };
      if (args.tabId !== undefined) out.tabId = args.tabId;
      if (args.newTab !== undefined) {
        if (typeof args.newTab !== "boolean") throw new Error("newTab must be boolean");
        out.newTab = args.newTab;
      }
      return { tool: normalizedTool, args: out };
    }
    case "click": {
      only(["tabId", "x", "y", "selector", "nodeIndex"]);
      assertOptionalTabId(args);
      const hasTarget =
        args.selector != null || args.nodeIndex != null || (args.x != null && args.y != null);
      if (!hasTarget) {
        throw new Error("click requires selector, nodeIndex, or x+y");
      }
      if (args.selector !== undefined && (typeof args.selector !== "string" || !args.selector)) {
        throw new Error("selector must be a non-empty string");
      }
      if (args.nodeIndex !== undefined) {
        if (
          typeof args.nodeIndex !== "number" ||
          !Number.isInteger(args.nodeIndex) ||
          args.nodeIndex < 0 ||
          args.nodeIndex > 199
        ) {
          throw new Error("nodeIndex must be an integer 0–199");
        }
      }
      if (args.x !== undefined && typeof args.x !== "number") throw new Error("x must be a number");
      if (args.y !== undefined && typeof args.y !== "number") throw new Error("y must be a number");
      return { tool: normalizedTool, args: { ...args } };
    }
    case "type": {
      only(["tabId", "text", "selector", "submit"]);
      assertOptionalTabId(args);
      if (typeof args.text !== "string") throw new Error("text is required");
      if (args.selector !== undefined && (typeof args.selector !== "string" || !args.selector)) {
        throw new Error("selector must be a non-empty string");
      }
      if (args.submit !== undefined && typeof args.submit !== "boolean") {
        throw new Error("submit must be boolean");
      }
      return { tool: normalizedTool, args: { ...args } };
    }
    default:
      throw new Error(`Unhandled tool ${tool}`);
  }
}

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
    description: "List live reverse-bridge sessions.",
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

function browserCatalogEntry(name: BrowserToolName): ToolDef {
  const definition = BROWSER_TOOL_DEFINITIONS[name];
  const base = {
    name: ToolName.make(browserToolCatalogName(name)),
    description: definition.description,
    inputSchema: definition.inputSchema,
  };
  return definition.risk === "read"
    ? base
    : {
        ...base,
        annotations: approval(
          `${definition.risk === "sensitive" ? "Allow sensitive" : "Run"} browser operation: ${name}`,
        ),
      };
}

export const BROWSER_TOOL_CATALOG: readonly ToolDef[] = [
  BROWSER_TOOL_CATALOG_V1[0]!,
  BROWSER_TOOL_CATALOG_V1[1]!,
  ...BROWSER_TOOL_NAMES.map(browserCatalogEntry),
];

function catalogResult(): ResolveToolsResult {
  return { tools: [...BROWSER_TOOL_CATALOG] };
}

const REMOTE_SESSION_TOOLS: readonly ToolDef[] = [
  {
    name: ToolName.make("session_status"),
    description: "Show the current remote browser session without starting one.",
    inputSchema: noArgsSchema,
  },
  {
    name: ToolName.make("session_start"),
    description: "Start or reuse this connection's remote browser session.",
    inputSchema: noArgsSchema,
    annotations: approval("Start a remote browser session that may incur provider usage"),
  },
  {
    name: ToolName.make("session_stop"),
    description: "Stop this connection's remote browser session.",
    inputSchema: noArgsSchema,
  },
];

function remoteCatalogResult(): ResolveToolsResult {
  return {
    tools: [...REMOTE_SESSION_TOOLS, ...BROWSER_TOOL_NAMES.map(browserCatalogEntry)],
  };
}

function remoteSessionKey(owner: OwnerLike, integration: string, connection: string): string {
  return `${userIdFromOwner(owner)}:${integration}:${connection}`;
}

function isRemoteBrowserConfig(
  config: BrowserIntegrationConfig | null,
): config is Exclude<BrowserIntegrationConfig, { provider: "local-extension" }> {
  return config !== null && config.provider !== "local-extension";
}

type BrowserTargetView = {
  readonly integration: string;
  readonly name: string;
  readonly provider: BrowserIntegrationConfig["provider"];
  readonly connection?: string;
  readonly address?: string;
  readonly state: "live" | "ready" | "offline" | "needs-connection";
  readonly detail: string;
  readonly session?: Omit<ReturnType<typeof listRemoteBrowserSessions>[number], "key">;
};

const remoteProviderSetup: Record<
  Exclude<BrowserIntegrationConfig["provider"], "local-extension">,
  { readonly setup: string; readonly note: string }
> = {
  "vercel-sandbox": {
    setup: "Vercel login or VERCEL_OIDC_TOKEN",
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

function remoteProviderHostReady(
  provider: Exclude<BrowserIntegrationConfig["provider"], "local-extension">,
): boolean {
  return provider !== "vercel-sandbox" || Boolean(process.env.VERCEL_OIDC_TOKEN);
}

function remoteProviderAvailability(
  provider: Exclude<BrowserIntegrationConfig["provider"], "local-extension">,
  configured: number,
): {
  readonly availability: "available" | "needs-setup" | "unavailable";
  readonly availabilityDetail: string;
} {
  if (!remoteProviderHostReady(provider)) {
    return {
      availability: "unavailable",
      availabilityDetail: "VERCEL_OIDC_TOKEN is not set on this Executor host",
    };
  }
  if (configured > 0) {
    return {
      availability: "available",
      availabilityDetail: `${configured} target${configured === 1 ? "" : "s"} configured`,
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
    const localConnection = localConnections[0];
    const localSession = localSessions[0];
    targets.push({
      integration: String(localRecord?.integration.slug || BROWSER_INTEGRATION_SLUG),
      name: localRecord?.integration.name || "Local Chrome",
      provider: "local-extension",
      connection: localConnection ? String(localConnection.name) : BROWSER_CONNECTION_NAME,
      address: localConnection?.address || "tools.browser.user.desktop",
      state: localSession ? "live" : "offline",
      detail: localSession
        ? `Extension ${String((localSession.client as { version?: string } | undefined)?.version || "connected")} connected · ${localSession.pending.length === 0 ? "no requests waiting" : `${localSession.pending.length} request${localSession.pending.length === 1 ? "" : "s"} waiting`}`
        : "Extension reverse session is not connected",
    });

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
        const hostReady = remoteProviderHostReady(record.config.provider);
        targets.push({
          integration: String(record.integration.slug),
          name: record.integration.name,
          provider: record.config.provider,
          connection: String(connection.name),
          address: connection.address,
          state: session ? "live" : hostReady ? "ready" : "offline",
          detail: session
            ? `Session ${session.sessionId} is active`
            : hostReady
              ? "Configured; starts on first browser call"
              : "Host authentication is missing; this target cannot start",
          ...(session ? { session: withoutSessionKey(session) } : {}),
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
  switch (input.provider) {
    case "vercel-sandbox":
      const timeoutMs = optionalNumber(input.timeoutMs, "Session timeout", { min: 1 });
      const vcpus = optionalNumber(input.vcpus, "vCPUs", { min: 1, integer: true });
      return {
        provider: input.provider,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(vcpus !== undefined ? { vcpus } : {}),
      };
    case "cloudflare-browser-run": {
      const keepAliveMs = optionalNumber(input.keepAliveMs, "Keep-alive", {
        min: 10_000,
        max: 1_200_000,
        integer: true,
      });
      return {
        provider: input.provider,
        accountId: requiredText(input.accountId, "Cloudflare account ID"),
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
        ...(input.liveUrl?.trim() ? { liveUrl: input.liveUrl.trim() } : {}),
        auth: headerName
          ? { kind: "header", headerName, prefix: input.authPrefix || "" }
          : { kind: "none" },
      };
    }
  }
}

function addBrowserProviderEffect(ctx: PluginCtx, input: AddBrowserProviderInput) {
  return Effect.gen(function* () {
    const config = yield* Effect.try({
      try: () => browserConfigFromInput(input),
      catch: (error) => browserBridgeError(error, "Invalid browser provider configuration"),
    });
    if (!remoteProviderHostReady(config.provider)) {
      return yield* new BrowserBridgeError({
        message: remoteProviderAvailability(config.provider, 0).availabilityDetail,
      });
    }
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
      (config.provider === "generic-cdp" && config.auth?.kind === "header");
    const credential = input.credential?.trim() || "";
    if (secretRequired && !credential) {
      return yield* new BrowserBridgeError({ message: "Provider credential is required" });
    }

    const name = input.name?.trim() || browserProviderName(config.provider);
    yield* ctx.core.integrations.register({
      slug,
      name,
      description: remoteProviderSetup[config.provider].note,
      config,
      canRemove: true,
      canRefresh: true,
    });
    const template =
      config.provider === "cloudflare-browser-run"
        ? "api-token"
        : config.provider === "browser-use"
          ? "api-key"
          : config.provider === "generic-cdp" && config.auth?.kind === "header"
            ? "header"
            : "none";
    const connectionName = ConnectionName.make(input.connectionName?.trim() || "default");
    const connection = yield* ctx.connections.create({
      owner: "user",
      name: connectionName,
      integration: slug,
      template: AuthTemplateSlug.make(template),
      value: credential,
      description: `${name} browser target`,
    });
    const overview = yield* browserOverviewEffect(ctx);
    return overview.targets.find(
      (target) =>
        target.integration === String(slug) && target.connection === String(connection.name),
    )!;
  });
}

const makeBrowserBridgeExtension = (ctx: PluginCtx) => ({
  ensureChrome: () => ensureChromeEffect(ctx),
  overview: () => browserOverviewEffect(ctx),
  addProvider: (input: AddBrowserProviderInput) => addBrowserProviderEffect(ctx, input),
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
      .handle("stopSession", ({ params }) =>
        Effect.gen(function* () {
          const extension = yield* BrowserBridgeExtensionService;
          return yield* extension.stopSession(params.integration, params.connection);
        }).pipe(
          Effect.mapError((error) => browserBridgeError(error, "Could not stop browser").message),
        ),
      ),
);

async function runTool(
  userId: string,
  toolName: string,
  args: Record<string, unknown> | undefined,
  timeoutMs: number,
  caller?: { name: string; version?: string } | null,
): Promise<unknown> {
  const name = browserToolNameFromCatalog(toolName) || toolName;

  if (name === "status") {
    const sessions = listSessionsForUser(userId).map(sessionPublicView);
    const live = sessions[0];
    return {
      sessions,
      live: Boolean(live),
      extension: live?.client ?? null,
      tools: (live?.capabilities as { tools?: string[] } | undefined)?.tools ?? [],
      pendingJobs: live?.pending ?? 0,
      note:
        sessions.length === 0
          ? "No live reverse session. Open Executor Browser → Connect (path B)."
          : `${sessions.length} session(s) live · ${live?.client && typeof live.client === "object" && "name" in live.client ? String((live.client as { name?: string }).name) : "extension"}`,
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
      sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
      timeoutMs: timeoutOverride,
      caller: caller ?? undefined,
    });
  }
  const validated = validateInnerCall(name, args || {});
  return callTool({
    userId,
    tool: validated.tool,
    args: validated.args,
    timeoutMs,
    caller: caller ?? undefined,
  });
}

function ensureChromeEffect(ctx: PluginCtx) {
  const slug = IntegrationSlug.make(BROWSER_INTEGRATION_SLUG);
  const connName = ConnectionName.make(BROWSER_CONNECTION_NAME);
  return Effect.gen(function* () {
    yield* ctx.core.integrations.register({
      slug,
      name: "Chrome (Executor Browser)",
      description:
        "Real Chrome via the Executor Browser extension reverse channel (path B). No companion process required.",
      config: LOCAL_BROWSER_CONFIG,
      canRemove: true,
      canRefresh: true,
    });

    // Effect v4: catchAll is gone — use catch / orElseSucceed
    const created = yield* ctx.connections
      .create({
        owner: "user",
        name: connName,
        integration: slug,
        template: AuthTemplateSlug.make("none"),
        value: "",
      })
      .pipe(
        Effect.map(() => true),
        Effect.catch(() => Effect.succeed(false)),
      );

    yield* ctx.connections
      .refresh({
        owner: "user",
        integration: slug,
        name: connName,
      })
      .pipe(Effect.catch(() => Effect.void));

    const sessions = listSessionsForUser(userIdFromOwner(ctx.owner));
    return {
      ok: true,
      integration: BROWSER_INTEGRATION_SLUG,
      connection: BROWSER_CONNECTION_NAME,
      address: "tools.browser.user.desktop",
      note: created
        ? `Chrome connection created.${sessions.length ? " Reverse session live." : " Connect extension for green status."}`
        : `Chrome connection ensured.${sessions.length ? " Reverse session live." : " Connect extension for green status."}`,
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
        name: "Chrome (Executor Browser)",
        summary: "Drive your real Chrome via the extension reverse channel (path B).",
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
    resolveTools: ({ config }) =>
      Effect.succeed(
        isRemoteBrowserConfig(parseBrowserIntegrationConfig(config))
          ? remoteCatalogResult()
          : catalogResult(),
      ),
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
            return getRemoteBrowserSession(key);
          }
          if (name === "session_start") {
            return yield* Effect.tryPromise({
              try: () => startRemoteBrowserSession(key, config, credential.value),
              catch: (error) => browserBridgeError(error, "Could not start remote browser"),
            });
          }
          if (name === "session_stop") {
            return yield* Effect.tryPromise({
              try: () => stopRemoteBrowserSession(key),
              catch: (error) => browserBridgeError(error, "Could not stop remote browser"),
            });
          }
          const validated = validateInnerCall(browserToolNameFromCatalog(name) || name, args || {});
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
        return yield* Effect.tryPromise({
          try: () =>
            runTool(
              userIdFromOwner(ctx.owner),
              String(toolRow.name),
              (args || {}) as Record<string, unknown>,
              defaultTimeout,
              caller,
            ),
          catch: (error) => browserBridgeError(error, "Local browser tool failed"),
        });
      }),

    checkHealth: ({ ctx, integration, credential }) =>
      Effect.sync(() => {
        const config = parseBrowserIntegrationConfig(integration.config);
        if (isRemoteBrowserConfig(config)) {
          const key = remoteSessionKey(
            ctx.owner,
            String(credential.integration),
            String(credential.connection),
          );
          const live = getRemoteBrowserSession(key);
          return {
            status: "healthy" as const,
            checkedAt: Date.now(),
            detail: live
              ? `${browserProviderName(config.provider)} session ${live.sessionId} is active`
              : `${browserProviderName(config.provider)} is configured; session starts on demand`,
          };
        }
        const userId = userIdFromOwner(ctx.owner);
        const sessions = listSessionsForUser(userId);
        const checkedAt = Date.now();
        if (sessions.length === 0) {
          return {
            // Must use HealthStatus vocab: healthy | expired | degraded | unknown
            status: "degraded" as const,
            checkedAt,
            detail: "No live reverse session. Open Executor Browser extension → Connect (path B).",
          };
        }
        const s = sessions[0]!;
        const ageMs = checkedAt - s.lastSeenAt;
        const client = (s.client || {}) as { name?: string; version?: string };
        const caps = (s.capabilities || {}) as { tools?: string[] };
        const toolN = caps.tools?.length ?? 0;
        if (ageMs > SESSION_STALE_MS) {
          return {
            status: "degraded" as const,
            checkedAt,
            detail: [
              `Reverse session stale (${Math.round(ageMs / 1000)}s since last poll)`,
              `session ${s.id.slice(0, 12)}…`,
              "Reconnect Executor Browser side panel.",
            ].join(" · "),
          };
        }
        return {
          status: "healthy" as const,
          checkedAt,
          detail: [
            `Reverse live · session ${s.id.slice(0, 12)}…`,
            client.name ? `ext ${client.name}@${client.version || "?"}` : null,
            toolN ? `${toolN} tools` : null,
            `lastSeen ${new Date(s.lastSeenAt).toISOString()}`,
          ]
            .filter(Boolean)
            .join(" · "),
        };
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

    // Only installer under executor — do NOT also declare static id "browser"
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
              "Create Chrome (Executor Browser) integration + tools.browser.user.desktop for this user.",
            outputSchema: InstallOutputStd,
            execute: () => self.ensureChrome(),
          }),
        ],
      },
    ],
  };
});
