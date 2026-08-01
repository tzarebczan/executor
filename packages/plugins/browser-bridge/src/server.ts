/**
 * @executor-js/plugin-browser-bridge/server
 *
 * Chrome desktop reverse channel (path B):
 * - Integration slug `browser` (visible in catalog; avoids clashing with MCP `chrome`)
 * - Connection `desktop` auto-created when extension opens a reverse session
 * - resolveTools / invokeTool back the reverse job store (not remote MCP)
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
} from "@executor-js/sdk/core";

import {
  callTool,
  listSessionsForUser,
  sessionPublicView,
} from "./store";

export interface BrowserBridgePluginOptions {
  readonly callTimeoutMs?: number;
}

/** Catalog slug — show as "Chrome (Executor Browser)" in the UI. */
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

type ExecCtx = {
  readonly ctx: {
    readonly owner: { readonly tenant: string; readonly subject: string | null };
  };
};

function userIdFromOwner(owner: { subject: string | null; tenant: string }): string {
  return String(owner.subject || owner.tenant || "anonymous");
}

const TOOL_CATALOG: readonly ToolDef[] = [
  {
    name: ToolName.make("status"),
    description:
      "List live reverse-bridge sessions for this user. Empty means the Executor Browser extension is not connected.",
  },
  {
    name: ToolName.make("call"),
    description:
      "Invoke a browser tool on the live extension session. Args: { tool, args?, sessionId?, timeoutMs? }. Tools: ping, tabs.list, tabs.open, navigate, snapshot, click, type, screenshot.",
  },
  {
    name: ToolName.make("snapshot"),
    description: "A11y-ish DOM snapshot of the active agent tab. Prefer over screenshot.",
  },
  {
    name: ToolName.make("navigate"),
    description: "Navigate a tab (or open newTab) to a URL. Args: { url, tabId?, newTab? }.",
  },
  {
    name: ToolName.make("click"),
    description: "Click by x/y, CSS selector, or snapshot nodeIndex.",
  },
  {
    name: ToolName.make("type"),
    description: "Type text into the focused input (or selector). Args: { text, selector?, submit? }.",
  },
  {
    name: ToolName.make("tabs.list"),
    description: "List tabs in the Executor agent tab group.",
  },
  {
    name: ToolName.make("tabs.open"),
    description: "Open a URL in a new agent-group tab. Args: { url? }.",
  },
  {
    name: ToolName.make("screenshot"),
    description: "JPEG screenshot of the active tab (prefer snapshot when possible).",
  },
  {
    name: ToolName.make("ping"),
    description: "Liveness check for the reverse bridge.",
  },
];

function catalogResult(): ResolveToolsResult {
  return { tools: [...TOOL_CATALOG] };
}

async function runTool(
  userId: string,
  toolName: string,
  args: Record<string, unknown> | undefined,
  timeoutMs: number,
): Promise<unknown> {
  if (toolName === "status") {
    const sessions = listSessionsForUser(userId).map(sessionPublicView);
    return {
      sessions,
      note:
        sessions.length === 0
          ? "No live reverse session. Open Executor Browser → Connect (Extension B)."
          : `${sessions.length} session(s) live`,
    };
  }
  if (toolName === "call") {
    const body = args || {};
    return callTool({
      userId,
      tool: String(body.tool || "ping"),
      args: (body.args as Record<string, unknown>) || {},
      sessionId: body.sessionId as string | undefined,
      timeoutMs: (body.timeoutMs as number) || timeoutMs,
    });
  }
  return callTool({
    userId,
    tool: toolName,
    args: args || {},
    timeoutMs,
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

    // Create user connection if missing (idempotent: ignore already-exists).
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
        Effect.catchAll(() => Effect.succeed(false)),
      );

    return {
      ok: true,
      integration: BROWSER_INTEGRATION_SLUG,
      connection: BROWSER_CONNECTION_NAME,
      address: `tools.browser.user.desktop`,
      note: created
        ? "Chrome connection created — tools sync from reverse bridge."
        : "Chrome connection already present (or create raced).",
    };
  });
}

export const browserBridgePlugin = definePlugin((options: BrowserBridgePluginOptions = {}) => {
  const defaultTimeout = options.callTimeoutMs ?? 45_000;

  return {
    id: "browser-bridge" as const,
    packageName: "@executor-js/plugin-browser-bridge",
    storage: () => ({}),

    // Discoverable in "add integration" style lists
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

    /** Full catalog is local — never report incomplete (that was the MCP chrome bug). */
    remoteToolCatalog: false,

    resolveTools: () => Effect.succeed(catalogResult()),

    invokeTool: ({ toolRow, args, ctx }) =>
      Effect.tryPromise({
        try: () =>
          runTool(
            userIdFromOwner(ctx.owner),
            String(toolRow.name),
            (args || {}) as Record<string, unknown>,
            defaultTimeout,
          ),
        catch: (e) => e as Error,
      }),

    checkHealth: ({ ctx }) =>
      Effect.sync(() => {
        const userId = userIdFromOwner(ctx.owner);
        const sessions = listSessionsForUser(userId);
        if (sessions.length === 0) {
          return {
            status: "degraded" as const,
            checkedAt: Date.now(),
            detail:
              "No live reverse session. Open Executor Browser extension → Connect (path B).",
          };
        }
        const s = sessions[0]!;
        return {
          status: "ok" as const,
          checkedAt: Date.now(),
          detail: `Reverse session ${s.id.slice(0, 12)}… · lastSeen ${new Date(s.lastSeenAt).toISOString()}`,
        };
      }),

    extension: (ctx: PluginCtx) => ({
      /** Register integration + user connection desktop (idempotent). */
      ensureChrome: () => ensureChromeEffect(ctx),
    }),

    // Static executor tools so the extension can install the catalog without a prior connection.
    staticIntegrations: (self: { ensureChrome: () => Effect.Effect<unknown> }) => [
      {
        id: "browserBridge",
        kind: "executor" as const,
        name: "Browser bridge",
        tools: [
          tool({
            name: "ensureChrome",
            description:
              "Register Chrome (Executor Browser) integration and create tools.browser.user.desktop for the current user. Call after extension reverse session opens. Safe to repeat.",
            outputSchema: InstallOutputStd,
            execute: (_args, _context) =>
              self.ensureChrome() as Effect.Effect<{
                ok: boolean;
                integration: string;
                connection: string;
                address: string;
                note: string;
              }>,
          }),
          tool({
            name: "status",
            description: "Live reverse-bridge sessions for the current user.",
            execute: (_args, context) =>
              Effect.sync(() => {
                const userId = userIdFromOwner((context as ExecCtx).ctx.owner);
                const sessions = listSessionsForUser(userId).map(sessionPublicView);
                return { sessions, count: sessions.length };
              }),
          }),
        ],
      },
    ],
  };
});
