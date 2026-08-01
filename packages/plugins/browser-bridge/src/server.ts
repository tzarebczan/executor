/**
 * Chrome desktop reverse channel (path B).
 *
 * Visibility strategy:
 * 1) Static integration `browser` — always in the catalog / tools list (no connection required).
 * 2) `ensureChrome` — also creates DB connection tools.browser.user.desktop for Connections UI + agents.
 * 3) resolveTools/invokeTool — power that connection once it exists.
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

import { callTool, listSessionsForUser, sessionPublicView } from "./store";

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

type OwnerLike = { readonly tenant: string; readonly subject: string | null };
type ExecCtx = { readonly ctx: { readonly owner: OwnerLike } };

function userIdFromOwner(owner: OwnerLike): string {
  return String(owner.subject || owner.tenant || "anonymous");
}

const TOOL_CATALOG: readonly ToolDef[] = [
  { name: ToolName.make("status"), description: "List live reverse-bridge sessions." },
  {
    name: ToolName.make("call"),
    description: "Invoke browser tool: ping|tabs.list|tabs.open|navigate|snapshot|click|type|screenshot.",
  },
  { name: ToolName.make("snapshot"), description: "A11y-ish DOM snapshot (prefer over screenshot)." },
  { name: ToolName.make("navigate"), description: "Navigate or open URL. Args: { url, newTab? }." },
  { name: ToolName.make("click"), description: "Click by x/y, selector, or nodeIndex." },
  { name: ToolName.make("type"), description: "Type into focused field. Args: { text, selector?, submit? }." },
  { name: ToolName.make("tabs_list"), description: "List Executor agent-group tabs." },
  { name: ToolName.make("tabs_open"), description: "Open URL in agent-group tab." },
  { name: ToolName.make("screenshot"), description: "JPEG of active tab." },
  { name: ToolName.make("ping"), description: "Liveness check." },
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
  // Map static-friendly names to extension tool names
  const map: Record<string, string> = {
    tabs_list: "tabs.list",
    tabs_open: "tabs.open",
  };
  const name = map[toolName] || toolName;

  if (name === "status") {
    const sessions = listSessionsForUser(userId).map(sessionPublicView);
    return {
      sessions,
      note:
        sessions.length === 0
          ? "No live reverse session. Open Executor Browser → Connect (path B)."
          : `${sessions.length} session(s) live`,
    };
  }
  if (name === "call") {
    const body = args || {};
    return callTool({
      userId,
      tool: String(body.tool || "ping"),
      args: (body.args as Record<string, unknown>) || {},
      sessionId: body.sessionId as string | undefined,
      timeoutMs: (body.timeoutMs as number) || timeoutMs,
    });
  }
  return callTool({ userId, tool: name, args: args || {}, timeoutMs });
}

function staticBrowserTools(timeoutMs: number) {
  const exec =
    (toolName: string) =>
    (args: unknown, context: ExecCtx) =>
      Effect.tryPromise({
        try: () =>
          runTool(
            userIdFromOwner(context.ctx.owner),
            toolName,
            (args || {}) as Record<string, unknown>,
            timeoutMs,
          ),
        catch: (e) => e as Error,
      });

  return [
    tool({
      name: "status",
      description: "List live reverse-bridge sessions for this user.",
      execute: exec("status"),
    }),
    tool({
      name: "snapshot",
      description: "DOM/a11y snapshot of the active agent tab.",
      execute: exec("snapshot"),
    }),
    tool({
      name: "navigate",
      description: "Navigate to a URL (args: { url, newTab? }).",
      execute: exec("navigate"),
    }),
    tool({
      name: "click",
      description: "Click by coordinates, selector, or nodeIndex.",
      execute: exec("click"),
    }),
    tool({
      name: "type",
      description: "Type text (args: { text, selector?, submit? }).",
      execute: exec("type"),
    }),
    tool({
      name: "tabs_list",
      description: "List tabs in the Executor agent group.",
      execute: exec("tabs_list"),
    }),
    tool({
      name: "tabs_open",
      description: "Open a URL in the agent tab group.",
      execute: exec("tabs_open"),
    }),
    tool({
      name: "screenshot",
      description: "Capture the active tab as JPEG.",
      execute: exec("screenshot"),
    }),
    tool({
      name: "ping",
      description: "Ping the reverse bridge.",
      execute: exec("ping"),
    }),
  ];
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
        Effect.catchAll((err) => {
          // already exists is fine
          console.warn("[browser-bridge] connections.create:", String(err));
          return Effect.succeed(false);
        }),
      );

    // Force tool catalog materialization for the connection
    yield* ctx.connections.refresh({
      owner: "user",
      integration: slug,
      name: connName,
    }).pipe(Effect.catchAll(() => Effect.void));

    return {
      ok: true,
      integration: BROWSER_INTEGRATION_SLUG,
      connection: BROWSER_CONNECTION_NAME,
      address: "tools.browser.user.desktop",
      note: created
        ? "Chrome connection created — appears under Connections."
        : "Chrome connection ensured (may already exist).",
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
            detail: "No live reverse session. Open Executor Browser → Connect (path B).",
          };
        }
        const s = sessions[0]!;
        return {
          status: "ok" as const,
          checkedAt: Date.now(),
          detail: `Reverse session live · ${s.id.slice(0, 12)}…`,
        };
      }),

    extension: (ctx: PluginCtx) => ({
      ensureChrome: () => ensureChromeEffect(ctx),
    }),

    staticIntegrations: (self: { ensureChrome: () => Effect.Effect<unknown> }) => [
      // Always-visible tools (Integrations / tool search) — no DB connection needed
      {
        id: "browser",
        kind: "browser-bridge" as const,
        name: "Chrome (Executor Browser)",
        canRemove: false,
        canRefresh: true,
        tools: staticBrowserTools(defaultTimeout),
      },
      // Installer under executor namespace so reverse session can provision Connections row
      {
        id: "browserBridge",
        kind: "executor" as const,
        name: "Browser bridge",
        tools: [
          tool({
            name: "ensureChrome",
            description:
              "Create Chrome (Executor Browser) integration + tools.browser.user.desktop connection for this user.",
            outputSchema: InstallOutputStd,
            execute: () =>
              self.ensureChrome() as Effect.Effect<{
                ok: boolean;
                integration: string;
                connection: string;
                address: string;
                note: string;
              }>,
          }),
        ],
      },
    ],
  };
});
