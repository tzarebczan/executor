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

function userIdFromOwner(owner: OwnerLike): string {
  return String(owner.subject || owner.tenant || "anonymous");
}

const TOOL_CATALOG: readonly ToolDef[] = [
  { name: ToolName.make("status"), description: "List live reverse-bridge sessions." },
  {
    name: ToolName.make("call"),
    description:
      "Invoke browser tool: ping|tabs.list|tabs.open|navigate|snapshot|click|type|screenshot.",
  },
  { name: ToolName.make("snapshot"), description: "A11y-ish DOM snapshot (prefer over screenshot)." },
  { name: ToolName.make("navigate"), description: "Navigate to URL. Args: { url, newTab? }." },
  { name: ToolName.make("click"), description: "Click by x/y, selector, or nodeIndex." },
  { name: ToolName.make("type"), description: "Type text. Args: { text, selector?, submit? }." },
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

    // Only installer under executor — do NOT also declare static id "browser"
    // (that duplicated the catalog row with no health dot).
    staticIntegrations: (self: { ensureChrome: () => Effect.Effect<unknown> }) => [
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
