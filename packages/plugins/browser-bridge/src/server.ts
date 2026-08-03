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
  Effect,
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
      config: { transport: "reverse", kind: "extension" },
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

    describeAuthMethods: () => [
      {
        id: "none",
        label: "Extension reverse (no secret)",
        kind: "none" as const,
        template: "none",
      },
    ],

    remoteToolCatalog: false,
    resolveTools: () => Effect.succeed(catalogResult()),
    invokeTool: ({ toolRow, args, ctx }) =>
      Effect.gen(function* () {
        const caller = yield* Effect.service(toolCallerRef);
        return yield* Effect.tryPromise({
          try: () =>
            runTool(
              userIdFromOwner(ctx.owner),
              String(toolRow.name),
              (args || {}) as Record<string, unknown>,
              defaultTimeout,
              caller,
            ),
          catch: (e) => e as Error,
        });
      }),

    checkHealth: ({ ctx }) =>
      Effect.sync(() => {
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

    extension: (ctx: PluginCtx) => ({
      ensureChrome: () => ensureChromeEffect(ctx),
    }),

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
