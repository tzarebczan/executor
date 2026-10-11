/**
 * Reverse channel for Executor Browser.
 *
 * The extension dials out and long-polls. Agents enqueue a tool call and wait.
 * Both happen on this process, so a waiting agent call does not block the
 * extension's poll. That is why this is a host route and not an app: app code
 * runs one invocation at a time inside workerd.
 */

export interface BridgePrincipal {
  readonly userId: string;
  readonly organizationId?: string;
}

export interface BridgeCaller {
  readonly name: string;
  readonly version?: string;
  readonly principal?: string;
}

interface BridgeJob {
  readonly id: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly createdAt: number;
  readonly caller?: BridgeCaller;
  delivered: boolean;
  resolve: (result: unknown) => void;
  reject: (error: string) => void;
}

interface BridgeSession {
  readonly id: string;
  readonly userId: string;
  readonly organizationId?: string;
  readonly kind: string;
  readonly transport: string;
  readonly client?: Record<string, unknown>;
  capabilities?: unknown;
  readonly connection?: Record<string, unknown>;
  readonly instanceId?: string;
  readonly browser?: string;
  readonly label?: string;
  readonly connectionName: string;
  readonly createdAt: number;
  lastSeenAt: number;
  pending: BridgeJob[];
  readonly inflight: Map<string, BridgeJob>;
  waiters: Array<{ resolve: (jobs: BridgeJob[]) => void; timer: ReturnType<typeof setTimeout> }>;
}

const SESSION_TTL_MS = 15 * 60 * 1000;
const DEFAULT_CALL_TIMEOUT_MS = 45_000;
const MAX_RESULT_JSON_BYTES = 6 * 1024 * 1024;
const DEFAULT_CONNECTION = "desktop";

export interface PublicSession {
  readonly sessionId: string;
  readonly kind: string;
  readonly transport: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly pending: number;
  readonly inflight: number;
  readonly client?: Record<string, unknown>;
  readonly capabilities?: unknown;
  readonly connection: string;
  readonly address: string;
  readonly browser?: string;
  readonly label?: string;
}

const AGENT_TOOLS = [
  { name: "ping", description: "Check that this browser is connected." },
  { name: "tabs.list", description: "List the tabs this browser lets agents use." },
  { name: "tabs.open", description: "Open a page in the agent tab group.", input: { url: { type: "string" } } },
  { name: "navigate", description: "Go to a URL in the current agent tab.", input: { url: { type: "string" } } },
  { name: "snapshot", description: "Read the structure of the current page." },
  { name: "click", description: "Click an element from the latest snapshot.", input: { selector: { type: "string" } } },
  { name: "type", description: "Type into an element from the latest snapshot.", input: { selector: { type: "string" }, text: { type: "string" } } },
  { name: "screenshot", description: "Capture the current page." },
  {
    name: "evaluate",
    description: "Run a CDP command. The browser must have developer tools on.",
    input: { method: { type: "string" }, params: { type: "object" } },
  },
] as const;

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function slug(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 32);
  return cleaned || DEFAULT_CONNECTION;
}

function preferredName(identity: { browser?: string; label?: string; requested?: string }): string {
  if (identity.requested && identity.requested !== DEFAULT_CONNECTION) return slug(identity.requested);
  if (identity.label) return slug(identity.label);
  const browser = identity.browser?.toLowerCase();
  if (!browser || browser === "chrome" || browser === "chromium") return DEFAULT_CONNECTION;
  return slug(browser);
}

function toolAddress(connectionName: string): string {
  return `tools.browser.user.${connectionName}`;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const unauthorized = () =>
  json(
    {
      error:
        "browser bridge requires an API key (Authorization: Bearer … or x-api-key); a browser session cookie is not accepted",
    },
    401,
  );

function readJson(request: Request): Promise<unknown> {
  return request.json().then(
    (value) => value,
    () => null,
  );
}

export function createBridge() {
  const sessions = new Map<string, BridgeSession>();

  function drop(id: string, reason: string): void {
    const session = sessions.get(id);
    if (!session) return;
    for (const job of session.pending) job.reject(reason);
    for (const job of session.inflight.values()) job.reject(reason);
    for (const waiter of session.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve([]);
    }
    sessions.delete(id);
  }

  function gc(): void {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastSeenAt > SESSION_TTL_MS) drop(id, "session expired");
    }
  }

  function touch(session: BridgeSession): void {
    session.lastSeenAt = Date.now();
  }

  function publicView(session: BridgeSession): PublicSession {
    return {
      sessionId: session.id,
      kind: session.kind,
      transport: session.transport,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      pending: session.pending.length,
      inflight: session.inflight.size,
      ...(session.client ? { client: session.client } : {}),
      ...(session.capabilities !== undefined ? { capabilities: session.capabilities } : {}),
      connection: session.connectionName,
      address: toolAddress(session.connectionName),
      ...(session.browser ? { browser: session.browser } : {}),
      ...(session.label ? { label: session.label } : {}),
    };
  }

  function listForUser(userId: string): BridgeSession[] {
    gc();
    return [...sessions.values()].filter((session) => session.userId === userId);
  }

  function allocate(userId: string, identity: { browser?: string; label?: string; requested?: string }): string {
    const taken = new Set(listForUser(userId).map((session) => session.connectionName));
    const preferred = preferredName(identity);
    if (!taken.has(preferred)) return preferred;
    const base = slug(identity.label || identity.browser || (preferred === DEFAULT_CONNECTION ? "chrome" : preferred));
    if (!taken.has(base)) return base;
    for (let n = 2; n < 100; n += 1) {
      const candidate = `${base}${n}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${base}${Date.now().toString(36)}`;
  }

  function openSession(principal: BridgePrincipal, body: Record<string, unknown> | null): BridgeSession {
    gc();
    const client = asRecord(body?.client);
    const connection = asRecord(body?.connection);
    const instanceId = readString(client?.instanceId);
    const browser = readString(client?.browser);
    const label = readString(client?.label);
    const requested = readString(connection?.name);
    let connectionName: string | undefined;
    const replacing: string[] = [];
    for (const [id, session] of sessions) {
      if (session.userId !== principal.userId) continue;
      const same = instanceId ? session.instanceId === instanceId : !session.instanceId;
      if (!same) continue;
      connectionName ??= session.connectionName;
      replacing.push(id);
    }
    for (const id of replacing) drop(id, "session replaced");
    const shownLabel = label || browser;
    connectionName ??= allocate(principal.userId, {
      ...(browser ? { browser } : {}),
      ...(label ? { label } : {}),
      ...(requested ? { requested } : {}),
    });
    const organizationId = principal.organizationId;
    const session: BridgeSession = {
      id: newId("bbs"),
      userId: principal.userId,
      ...(organizationId ? { organizationId } : {}),
      kind: readString(body?.kind) || "chrome-extension",
      transport: readString(body?.transport) || "reverse-longpoll",
      ...(client ? { client } : {}),
      ...(body?.capabilities !== undefined ? { capabilities: body.capabilities } : {}),
      ...(connection ? { connection } : {}),
      ...(instanceId ? { instanceId } : {}),
      ...(browser ? { browser } : {}),
      ...(shownLabel ? { label: shownLabel } : {}),
      connectionName,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      pending: [],
      inflight: new Map(),
      waiters: [],
    };
    sessions.set(session.id, session);
    return session;
  }

  function drain(session: BridgeSession): Array<{ id: string; tool: string; args: Record<string, unknown>; caller?: BridgeCaller }> {
    const batch = session.pending.splice(0, session.pending.length);
    for (const job of batch) {
      job.delivered = true;
      session.inflight.set(job.id, job);
    }
    return batch.map((job) => ({
      id: job.id,
      tool: job.tool,
      args: job.args,
      ...(job.caller ? { caller: job.caller } : {}),
    }));
  }

  function notify(session: BridgeSession): void {
    if (session.waiters.length === 0 || session.pending.length === 0) return;
    const waiter = session.waiters.shift();
    if (!waiter) return;
    clearTimeout(waiter.timer);
    waiter.resolve(session.pending.splice(0, session.pending.length).map((job) => {
      job.delivered = true;
      session.inflight.set(job.id, job);
      return job;
    }));
  }

  function takeJobs(sessionId: string, userId: string, waitMs: number): Promise<{ ok: true; jobs: ReturnType<typeof drain> } | { ok: false; error: string }> {
    const session = sessions.get(sessionId);
    if (!session || session.userId !== userId) return Promise.resolve({ ok: false, error: "session not found" });
    touch(session);
    if (session.pending.length > 0) return Promise.resolve({ ok: true, jobs: drain(session) });
    const ms = Math.min(Math.max(waitMs, 0), 30_000);
    if (ms === 0) return Promise.resolve({ ok: true, jobs: [] });
    return new Promise((resolve) => {
      const resolveJobs = (jobs: BridgeJob[]) => {
        clearTimeout(timer);
        resolve({
          ok: true,
          jobs: jobs.map((job) => ({
            id: job.id,
            tool: job.tool,
            args: job.args,
            ...(job.caller ? { caller: job.caller } : {}),
          })),
        });
      };
      const timer = setTimeout(() => {
        session.waiters = session.waiters.filter((waiter) => waiter.resolve !== resolveJobs);
        resolve({ ok: true, jobs: [] });
      }, ms);
      session.waiters.push({ resolve: resolveJobs, timer });
    });
  }

  function postResult(sessionId: string, userId: string, jobId: string, result: unknown): { ok: true } | { ok: false; error: string } {
    const session = sessions.get(sessionId);
    if (!session || session.userId !== userId) return { ok: false, error: "session not found" };
    touch(session);
    let encoded = "";
    const encodedResult = JSON.stringify(result ?? null);
    if (encodedResult === undefined) return { ok: false, error: "result is not JSON" };
    encoded = encodedResult;
    if (encoded.length > MAX_RESULT_JSON_BYTES) {
      const job = session.inflight.get(jobId);
      if (!job) return { ok: false, error: "job not found" };
      session.inflight.delete(jobId);
      job.reject(`browser tool result too large (${encoded.length} bytes)`);
      return { ok: true };
    }
    const job = session.inflight.get(jobId) ?? session.pending.find((item) => item.id === jobId);
    if (!job) return { ok: false, error: "job not found" };
    session.inflight.delete(jobId);
    session.pending = session.pending.filter((item) => item.id !== jobId);
    job.resolve(result);
    return { ok: true };
  }

  function sessionForCall(userId: string, sessionId?: string, connection?: string): BridgeSession | undefined {
    gc();
    if (sessionId) {
      const session = sessions.get(sessionId);
      return session && session.userId === userId ? session : undefined;
    }
    const live = listForUser(userId);
    if (connection) return live.find((session) => session.connectionName === connection);
    return live.length === 1 ? live[0] : undefined;
  }

  function callTool(input: {
    readonly userId: string;
    readonly tool: string;
    readonly args?: Record<string, unknown>;
    readonly sessionId?: string;
    readonly connection?: string;
    readonly timeoutMs?: number;
    readonly caller?: BridgeCaller;
  }): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    const session = sessionForCall(input.userId, input.sessionId, input.connection);
    if (!session) {
      const live = listForUser(input.userId);
      const error = live.length > 1
        ? `Multiple browsers are connected (${live.map((item) => toolAddress(item.connectionName)).join(", ")}). Name which one.`
        : "No browser is connected. Open Executor Browser and connect.";
      return Promise.resolve({ ok: false, error });
    }
    const timeoutMs = input.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    const jobId = newId("job");
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        session.pending = session.pending.filter((job) => job.id !== jobId);
        session.inflight.delete(jobId);
        resolve({ ok: false, error: `browser tool timeout after ${timeoutMs}ms (${input.tool})` });
      }, timeoutMs);
      const job: BridgeJob = {
        id: jobId,
        tool: input.tool,
        args: input.args ?? {},
        createdAt: Date.now(),
        delivered: false,
        ...(input.caller ? { caller: input.caller } : {}),
        resolve: (result) => {
          clearTimeout(timer);
          resolve({ ok: true, result });
        },
        reject: (error) => {
          clearTimeout(timer);
          resolve({ ok: false, error });
        },
      };
      session.pending.push(job);
      notify(session);
    });
  }

  async function handleMcp(request: Request, principal: BridgePrincipal): Promise<Response> {
    const body = asRecord(await readJson(request));
    const id = body?.id ?? null;
    const method = readString(body?.method) || "";
    const params = asRecord(body?.params) ?? {};
    if (method === "initialize") {
      return json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: readString(params.protocolVersion) || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "executor-browser", version: "2" },
        },
      });
    }
    if (method === "notifications/initialized" || method === "initialized") {
      return new Response(null, { status: 202 });
    }
    if (method === "tools/list") {
      return json({
        jsonrpc: "2.0",
        id,
        result: {
          tools: AGENT_TOOLS.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: {
              type: "object",
              properties: "input" in tool ? tool.input : {},
            },
          })),
        },
      });
    }
    if (method === "tools/call") {
      const name = readString(params.name);
      if (!name) {
        return json({ jsonrpc: "2.0", id, error: { code: -32602, message: "tool name required" } });
      }
      const args = asRecord(params.arguments) ?? {};
      const connection = readString(args.connection);
      const toolArgs = { ...args };
      delete toolArgs.connection;
      const result = await callTool({
        userId: principal.userId,
        tool: name,
        args: toolArgs,
        ...(connection ? { connection } : {}),
        caller: { name: "mcp", principal: principal.userId },
      });
      if (!result.ok) {
        return json({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: result.error }], isError: true },
        });
      }
      return json({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(result.result) }] },
      });
    }
    return json({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
  }

  async function handle(request: Request, principal: BridgePrincipal | null): Promise<Response> {
    const url = new URL(request.url);
    let path = url.pathname;
    for (const marker of ["/api/browser-bridge", "/browser-bridge"]) {
      if (path === marker || path.startsWith(`${marker}/`)) {
        path = path.slice(marker.length) || "/";
        break;
      }
    }
    if (!principal) return unauthorized();

    if (path === "/mcp" && request.method === "POST") return handleMcp(request, principal);
    if (path === "/session" && request.method === "POST") {
      const body = asRecord(await readJson(request)) ?? null;
      const session = openSession(principal, body);
      return json({
        ...publicView(session),
        id: session.id,
        pollPath: `/api/browser-bridge/session/${session.id}/jobs`,
        resultPath: `/api/browser-bridge/session/${session.id}/result`,
        integration: "browser",
        connection: session.connectionName,
        address: toolAddress(session.connectionName),
      });
    }
    if (path === "/sessions" && request.method === "GET") {
      return json({ sessions: listForUser(principal.userId).map(publicView) });
    }
    if (path === "/call" && request.method === "POST") {
      const body = asRecord(await readJson(request));
      const tool = readString(body?.tool);
      if (!tool) return json({ error: "tool required" }, 400);
      const sessionId = readString(body?.sessionId);
      const connectionName = readString(body?.connection);
      const result = await callTool({
        userId: principal.userId,
        tool,
        args: asRecord(body?.args) ?? {},
        ...(sessionId ? { sessionId } : {}),
        ...(connectionName ? { connection: connectionName } : {}),
      });
      return result.ok ? json({ result: result.result }) : json({ error: result.error }, 409);
    }

    const match = path.match(/^\/session\/([^/]+)(?:\/(jobs|result))?$/);
    if (!match) return json({ error: `unknown browser-bridge path ${path}` }, 404);
    const sessionId = decodeURIComponent(match[1] ?? "");
    const sub = match[2];
    if (!sub && request.method === "DELETE") {
      const session = sessions.get(sessionId);
      if (!session || session.userId !== principal.userId) return json({ error: "session not found" }, 404);
      drop(sessionId, "session closed");
      return json({ ok: true });
    }
    if (!sub && request.method === "GET") {
      const session = sessions.get(sessionId);
      if (!session || session.userId !== principal.userId) return json({ error: "session not found" }, 404);
      return json(publicView(session));
    }
    if (!sub && request.method === "PATCH") {
      const body = asRecord(await readJson(request));
      if (body?.capabilities === undefined) return json({ error: "capabilities required" }, 400);
      const session = sessions.get(sessionId);
      if (!session || session.userId !== principal.userId) return json({ error: "session not found" }, 404);
      session.capabilities = body.capabilities;
      touch(session);
      return json({ ok: true });
    }
    if (sub === "jobs" && request.method === "GET") {
      const waitMs = Number(url.searchParams.get("waitMs") || "25000");
      const taken = await takeJobs(sessionId, principal.userId, Number.isFinite(waitMs) ? waitMs : 25000);
      return taken.ok ? json({ jobs: taken.jobs }) : json({ error: taken.error }, 404);
    }
    if (sub === "result" && request.method === "POST") {
      const body = asRecord(await readJson(request));
      const jobId = readString(body?.jobId);
      if (!jobId) return json({ error: "jobId required" }, 400);
      const posted = postResult(sessionId, principal.userId, jobId, body?.result);
      return posted.ok ? json({ ok: true }) : json({ error: posted.error }, 404);
    }
    return json({ error: `unknown browser-bridge path ${path}` }, 404);
  }

  return {
    handle,
    listPublic(userId: string): readonly PublicSession[] {
      return listForUser(userId).map(publicView);
    },
    callTool,
  };
}

export type BrowserBridge = ReturnType<typeof createBridge>;
