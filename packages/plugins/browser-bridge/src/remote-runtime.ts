/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor, executor/no-switch-statement, executor/no-promise-catch, executor/no-double-cast -- browser/CDP boundary normalizes third-party failures and typed CLI payloads */

import puppeteer, {
  type Browser,
  type BrowserContext,
  type Dialog,
  type ElementHandle,
  type KeyInput,
  type Page,
} from "puppeteer-core";
import type { BrowserCommandResult } from "remote-agent-browser";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { createCloudBrowserSession, type CloudBrowserHandle } from "./cloud-providers";
import {
  BROWSER_PROTOCOL_VERSION,
  type BrowserElementTarget,
  type BrowserSnapshotNode,
  type BrowserTab,
  type BrowserToolInputMap,
  type BrowserToolName,
  type BrowserToolResult,
} from "./protocol";
import type { BrowserIntegrationConfig } from "./integration-config";

export interface RemoteBrowserSessionSummary {
  readonly key: string;
  readonly provider: Exclude<BrowserIntegrationConfig["provider"], "local-extension">;
  readonly sessionId: string;
  readonly transport: "agent-browser" | "cdp";
  readonly createdAt: number;
  readonly lastUsedAt: number;
  /** Epoch ms at which this session is closed if nothing uses it before then. */
  readonly idleExpiresAt: number;
  readonly liveUrl?: string;
  readonly recordingUrl?: string;
  readonly expiresAt?: string;
}

export type RemoteBrowserFailureReason =
  | "config"
  | "auth"
  | "permission"
  | "quota"
  | "network"
  | "provider";

export interface RemoteBrowserFailure {
  readonly key: string;
  readonly provider: Exclude<BrowserIntegrationConfig["provider"], "local-extension">;
  readonly reason: RemoteBrowserFailureReason;
  readonly detail: string;
  readonly hint: string;
  readonly failedAt: number;
}

type ConsoleEntry = {
  readonly level: string;
  readonly text: string;
  readonly timestamp: number;
  readonly tabId: number;
};

type NetworkEntry = {
  readonly method: string;
  readonly url: string;
  readonly resourceType: string;
  readonly timestamp: number;
  readonly tabId: number;
};

type DownloadEntry = {
  readonly id: string;
  readonly filename: string;
  readonly state: "in_progress" | "complete" | "interrupted";
  readonly startedAt: number;
  readonly completedAt?: number;
};

type CdpRuntime = {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly pageIds: Map<Page, number>;
  readonly pagesById: Map<number, Page>;
  readonly snapshotNodes: Map<
    number,
    { readonly url: string; readonly nodes: readonly BrowserSnapshotNode[] }
  >;
  readonly console: ConsoleEntry[];
  readonly network: NetworkEntry[];
  readonly downloads: DownloadEntry[];
  nextPageId: number;
  activePageId: number | null;
  lastDialog: Dialog | null;
};

type RuntimeSession = {
  readonly key: string;
  readonly config: Exclude<BrowserIntegrationConfig, { provider: "local-extension" }>;
  readonly handle: CloudBrowserHandle;
  readonly createdAt: number;
  lastUsedAt: number;
  /** Tool calls currently running against this session. Never reap above zero. */
  inFlight: number;
  readonly cdp?: CdpRuntime;
  readonly vercelTabRefs: Map<number, string>;
  readonly vercelSnapshotRefs: Map<number, string>;
  nextVercelTabId: number;
  activeVercelTabId: number | null;
};

const sessions = new Map<string, RuntimeSession>();
const failures = new Map<string, RemoteBrowserFailure>();

function failureText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === "object") {
      const record = current as {
        readonly name?: unknown;
        readonly message?: unknown;
        cause?: unknown;
      };
      if (typeof record.name === "string") parts.push(record.name);
      if (typeof record.message === "string") parts.push(record.message);
      current = record.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(" ").toLowerCase();
}

function providerLabel(
  provider: Exclude<BrowserIntegrationConfig["provider"], "local-extension">,
): string {
  switch (provider) {
    case "vercel-sandbox":
      return "Vercel Sandbox";
    case "cloudflare-browser-run":
      return "Cloudflare Browser Run";
    case "browser-use":
      return "Browser Use";
    case "generic-cdp":
      return "CDP browser";
  }
}

export function classifyRemoteBrowserFailure(
  key: string,
  provider: Exclude<BrowserIntegrationConfig["provider"], "local-extension">,
  error: unknown,
  failedAt = Date.now(),
): RemoteBrowserFailure {
  const text = failureText(error);
  const label = providerLabel(provider);

  // Scope: these two remedies name a Vercel project, a team ID, and a Vercel
  // Container Registry, none of which exist for the other providers. Matched on
  // message text alone they misfire, a Cloudflare 404 (wrong account ID, or
  // Browser Rendering not enabled) was being answered with "push the configured
  // image to that project's Vercel Container Registry", which is not a worse
  // hint so much as an instruction for a different product.
  const isVercel = provider === "vercel-sandbox";

  if (
    isVercel &&
    (text.includes("teamid") ||
      text.includes("projectid") ||
      text.includes("team id") ||
      text.includes("project id") ||
      text.includes("missing credentials parameters"))
  ) {
    return {
      key,
      provider,
      reason: "config",
      detail: `${label} could not start because its setup is incomplete`,
      hint: "Add the required team and project IDs, then try the browser again.",
      failedAt,
    };
  }
  if (
    isVercel &&
    (text.includes("status code 404") || text.includes("status 404") || text.includes("(404)"))
  ) {
    return {
      key,
      provider,
      reason: "config",
      // The image is only consulted when the target names one; without it the
      // sandbox boots from a stock runtime and installs the browser itself. So
      // this hint leads with the remedy that applies to a default target, and
      // mentions the registry only for people who chose an image on purpose.
      detail: `${label} could not find the configured project or browser image`,
      hint: "Clear the Browser image setting to let the sandbox install its own, or push that image to the project's Vercel Container Registry.",
      failedAt,
    };
  }
  if (text.includes("status code 404") || text.includes("status 404") || text.includes("(404)")) {
    return {
      key,
      provider,
      reason: "config",
      detail: `${label} could not find the configured target`,
      hint: "Check this target's account and endpoint settings, then try the browser again.",
      failedAt,
    };
  }
  if (
    text.includes("credit") ||
    text.includes("billing") ||
    text.includes("payment required") ||
    text.includes("insufficient funds") ||
    text.includes("quota") ||
    text.includes("resource exhausted") ||
    text.includes("status 402") ||
    text.includes("(402)")
  ) {
    return {
      key,
      provider,
      reason: "quota",
      detail: `${label} could not start because the account has no available credits or quota`,
      hint: "Add provider credits or increase its quota, then try the browser again.",
      failedAt,
    };
  }
  if (
    text.includes("unauthorized") ||
    text.includes("invalid token") ||
    text.includes("authentication") ||
    text.includes("status 401") ||
    text.includes("(401)")
  ) {
    return {
      key,
      provider,
      reason: "auth",
      detail: `${label} rejected the configured credential`,
      hint: "Replace the credential with a valid provider token and try again.",
      failedAt,
    };
  }
  if (
    text.includes("forbidden") ||
    text.includes("permission") ||
    text.includes("status 403") ||
    text.includes("(403)")
  ) {
    return {
      key,
      provider,
      reason: "permission",
      detail: `${label} refused permission to start a browser`,
      hint: "Grant the credential access to this team and project, then try again.",
      failedAt,
    };
  }
  if (
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("econn") ||
    text.includes("enotfound") ||
    text.includes("network") ||
    text.includes("fetch failed")
  ) {
    return {
      key,
      provider,
      reason: "network",
      detail: `${label} could not be reached while starting the browser`,
      hint: "Check Executor's network path to the provider and try again.",
      failedAt,
    };
  }
  return {
    key,
    provider,
    reason: "provider",
    detail: `${label} returned an unexpected error while starting the browser`,
    hint: "Retry once; if it fails again, check the Executor server logs for the provider error.",
    failedAt,
  };
}

export function getRemoteBrowserFailure(key: string): RemoteBrowserFailure | null {
  return failures.get(key) || null;
}

/**
 * Idle window for a remote session when the target does not set one.
 *
 * Long enough that an agent pausing to think does not lose its browser, short
 * enough that a forgotten session is not billed all afternoon. Reaping is not
 * free: the next tool call starts a fresh browser, which loses open tabs and
 * any signed-in state, so callers are told when a session will go
 * (`idleExpiresAt`) rather than finding out afterwards.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
const REAP_INTERVAL_MS = 30_000;

/**
 * A total lifetime the provider grants from creation, where it grants one.
 *
 * Vercel's sandbox timeout and Browser Use's session timeout are measured from
 * when the session started, not from when it was last touched, using them as
 * an idle window would let a session that is used every minute advertise an
 * expiry that keeps sliding past the moment the provider actually kills it.
 * Cloudflare's `keep_alive` is genuinely idle-based, so it is not one of these.
 */
function providerTotalLifetimeMs(
  config: Exclude<BrowserIntegrationConfig, { provider: "local-extension" }>,
): number | undefined {
  if (config.provider === "browser-use") {
    return config.timeoutMinutes ? config.timeoutMinutes * 60_000 : undefined;
  }
  if (config.provider === "vercel-sandbox") return config.timeoutMs;
  return undefined;
}

/**
 * How long this target's session may sit unused.
 *
 * Capped by the provider's own idle allowance where it has one, because
 * holding a handle past that point only hides the failure until the next call.
 */
export function idleTimeoutMsFor(
  config: Exclude<BrowserIntegrationConfig, { provider: "local-extension" }>,
): number {
  const requested =
    config.idleTimeoutMs && config.idleTimeoutMs > 0
      ? config.idleTimeoutMs
      : DEFAULT_IDLE_TIMEOUT_MS;
  const providerIdleMs =
    config.provider === "cloudflare-browser-run" ? config.keepAliveMs : undefined;
  const total = providerTotalLifetimeMs(config);
  return Math.min(requested, providerIdleMs ?? Infinity, total ?? Infinity);
}

/**
 * When this session goes: whichever comes first, our idle window running out or
 * the provider's own total lifetime expiring.
 */
function idleExpiresAt(session: RuntimeSession): number {
  const idle = session.lastUsedAt + idleTimeoutMsFor(session.config);
  const total = providerTotalLifetimeMs(session.config);
  return total === undefined ? idle : Math.min(idle, session.createdAt + total);
}

let reaper: ReturnType<typeof setInterval> | null = null;

/**
 * Close every session whose idle window has elapsed.
 *
 * A session with work in flight is never idle, whatever the clock says: a call
 * that outruns the window, a slow navigation, a large PDF, must not have the
 * browser closed out from under it.
 */
export async function reapIdleRemoteBrowserSessions(now = Date.now()): Promise<readonly string[]> {
  const expired = [...sessions.values()]
    .filter((session) => session.inFlight === 0 && now >= idleExpiresAt(session))
    .map((session) => session.key);
  await Promise.all(expired.map((key) => stopRemoteBrowserSession(key)));
  return expired;
}

function startReaper(): void {
  if (reaper) return;
  reaper = setInterval(() => {
    void reapIdleRemoteBrowserSessions();
  }, REAP_INTERVAL_MS);
  // A background sweep must never be the reason the process stays alive.
  reaper.unref?.();
}

function stopReaperIfIdle(): void {
  if (reaper && sessions.size === 0) {
    clearInterval(reaper);
    reaper = null;
  }
}

function toolResult<Name extends BrowserToolName>(value: unknown): BrowserToolResult<Name> {
  return value as BrowserToolResult<Name>;
}

function redactText(value: string): string {
  return value
    .replace(/(bearer\s+)[a-z0-9._~+\-/]+=*/gi, "$1[redacted]")
    .replace(/([?&](?:token|key|secret|password|code)=)[^&#\s]+/gi, "$1[redacted]")
    .slice(0, 1000);
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value.split(/[?#]/, 1)[0] || value;
  }
}

function trimBuffer<T>(items: T[], max = 500): void {
  if (items.length > max) items.splice(0, items.length - max);
}

function cloudConfig(
  config: Exclude<BrowserIntegrationConfig, { provider: "local-extension" }>,
  credential: string | null,
) {
  switch (config.provider) {
    case "vercel-sandbox":
      if (config.auth === "token") {
        if (!credential) throw new Error("Vercel API token is required");
        return { ...config, token: credential };
      }
      return config;
    case "cloudflare-browser-run":
      if (!credential) throw new Error("Cloudflare API token is required");
      return { ...config, apiToken: credential };
    case "browser-use":
      if (!credential) throw new Error("Browser Use API key is required");
      return { ...config, apiKey: credential };
    case "generic-cdp": {
      const headers =
        config.auth?.kind === "header" && credential
          ? { [config.auth.headerName]: `${config.auth.prefix || ""}${credential}` }
          : undefined;
      return { provider: config.provider, cdpUrl: config.cdpUrl, liveUrl: config.liveUrl, headers };
    }
  }
}

function pageTab(runtime: CdpRuntime, page: Page): BrowserTab {
  return {
    id: runtime.pageIds.get(page)!,
    active: runtime.activePageId === runtime.pageIds.get(page),
    title: "",
    url: page.url(),
    controlled: true,
  };
}

async function hydratedPageTab(runtime: CdpRuntime, page: Page): Promise<BrowserTab> {
  const tab = pageTab(runtime, page);
  return { ...tab, title: await page.title().catch(() => "") };
}

function registerPage(runtime: CdpRuntime, page: Page): number {
  const existing = runtime.pageIds.get(page);
  if (existing != null) return existing;
  const id = runtime.nextPageId++;
  runtime.pageIds.set(page, id);
  runtime.pagesById.set(id, page);
  runtime.activePageId ??= id;
  page.on("close", () => {
    runtime.pageIds.delete(page);
    runtime.pagesById.delete(id);
    runtime.snapshotNodes.delete(id);
    if (runtime.activePageId === id)
      runtime.activePageId = runtime.pagesById.keys().next().value ?? null;
  });
  page.on("console", (message) => {
    runtime.console.push({
      level: message.type(),
      text: redactText(message.text()),
      timestamp: Date.now(),
      tabId: id,
    });
    trimBuffer(runtime.console);
  });
  page.on("request", (request) => {
    runtime.network.push({
      method: request.method(),
      url: redactUrl(request.url()),
      resourceType: request.resourceType(),
      timestamp: Date.now(),
      tabId: id,
    });
    trimBuffer(runtime.network);
  });
  page.on("dialog", (dialog: Dialog) => {
    runtime.lastDialog = dialog;
  });
  void page
    .createCDPSession()
    .then(async (client) => {
      await client.send("Browser.setDownloadBehavior", {
        behavior: "default",
        eventsEnabled: true,
      });
      client.on("Browser.downloadWillBegin", (event) => {
        runtime.downloads.push({
          id: event.guid,
          filename: event.suggestedFilename,
          state: "in_progress",
          startedAt: Date.now(),
        });
        trimBuffer(runtime.downloads, 100);
      });
      client.on("Browser.downloadProgress", (event) => {
        if (event.state === "inProgress") return;
        const index = runtime.downloads.findIndex((entry) => entry.id === event.guid);
        if (index < 0) return;
        const current = runtime.downloads[index]!;
        runtime.downloads[index] = {
          ...current,
          state: event.state === "completed" ? "complete" : "interrupted",
          completedAt: Date.now(),
        };
      });
    })
    .catch(() => {});
  return id;
}

async function connectCdp(handle: CloudBrowserHandle): Promise<CdpRuntime> {
  if (!handle.session.cdpUrl) throw new Error("Provider did not return a CDP endpoint");
  const endpoint = new URL(handle.session.cdpUrl);
  const browser = await puppeteer.connect({
    ...(endpoint.protocol === "http:" || endpoint.protocol === "https:"
      ? { browserURL: endpoint.toString() }
      : { browserWSEndpoint: endpoint.toString() }),
    headers: handle.connectionHeaders ? { ...handle.connectionHeaders } : undefined,
    protocolTimeout: 30_000,
  });
  const context = browser.defaultBrowserContext();
  const runtime: CdpRuntime = {
    browser,
    context,
    pageIds: new Map(),
    pagesById: new Map(),
    snapshotNodes: new Map(),
    console: [],
    network: [],
    downloads: [],
    nextPageId: 1,
    activePageId: null,
    lastDialog: null,
  };
  const pages = await context.pages();
  for (const page of pages) registerPage(runtime, page);
  context.on("targetcreated", (target) => {
    void target
      .page()
      .then((page) => {
        if (page) registerPage(runtime, page);
      })
      .catch(() => {});
  });
  if (pages.length === 0) registerPage(runtime, await context.newPage());
  return runtime;
}

/**
 * In-flight cold starts, keyed by target.
 *
 * Creating a session is check-await-set, so two calls arriving together on a
 * cold target would both see an empty map, both pay for a browser, and the
 * second `set` would orphan the first, unreachable by the reaper or by
 * `stopAll`, and billing until the provider itself gave up. Callers share one
 * creation instead.
 */
const starting = new Map<string, Promise<RemoteBrowserSessionSummary>>();

export async function startRemoteBrowserSession(
  key: string,
  config: Exclude<BrowserIntegrationConfig, { provider: "local-extension" }>,
  credential: string | null,
): Promise<RemoteBrowserSessionSummary> {
  const existing = sessions.get(key);
  if (existing) {
    failures.delete(key);
    existing.lastUsedAt = Date.now();
    return summarize(existing);
  }
  const pending = starting.get(key);
  if (pending) return pending;
  const created = createRemoteBrowserSession(key, config, credential)
    .then((session) => {
      failures.delete(key);
      return session;
    })
    .catch((error) => {
      failures.set(key, classifyRemoteBrowserFailure(key, config.provider, error));
      throw error;
    })
    .finally(() => starting.delete(key));
  starting.set(key, created);
  return created;
}

async function createRemoteBrowserSession(
  key: string,
  config: Exclude<BrowserIntegrationConfig, { provider: "local-extension" }>,
  credential: string | null,
): Promise<RemoteBrowserSessionSummary> {
  const handle = await createCloudBrowserSession(cloudConfig(config, credential));
  try {
    const session: RuntimeSession = {
      key,
      config,
      handle,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      inFlight: 0,
      vercelTabRefs: new Map(),
      vercelSnapshotRefs: new Map(),
      nextVercelTabId: 1,
      activeVercelTabId: null,
      ...(handle.session.transport === "cdp" ? { cdp: await connectCdp(handle) } : {}),
    };
    sessions.set(key, session);
    startReaper();
    return summarize(session);
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

export async function stopRemoteBrowserSession(key: string): Promise<boolean> {
  failures.delete(key);
  const session = sessions.get(key);
  if (!session) return false;
  sessions.delete(key);
  stopReaperIfIdle();
  await session.cdp?.browser.close().catch(() => {});
  await session.handle.close().catch(() => {});
  return true;
}

export async function stopAllRemoteBrowserSessions(): Promise<void> {
  await Promise.all([...sessions.keys()].map((key) => stopRemoteBrowserSession(key)));
  failures.clear();
}

function summarize(session: RuntimeSession): RemoteBrowserSessionSummary {
  return {
    key: session.key,
    provider: session.config.provider,
    sessionId: session.handle.session.sessionId,
    transport: session.handle.session.transport,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    idleExpiresAt: idleExpiresAt(session),
    ...(session.handle.session.liveUrl ? { liveUrl: session.handle.session.liveUrl } : {}),
    ...(session.handle.session.recordingUrl
      ? { recordingUrl: session.handle.session.recordingUrl }
      : {}),
    ...(session.handle.session.expiresAt ? { expiresAt: session.handle.session.expiresAt } : {}),
  };
}

export function listRemoteBrowserSessions(prefix?: string): readonly RemoteBrowserSessionSummary[] {
  return [...sessions.values()]
    .filter((session) => !prefix || session.key.startsWith(prefix))
    .map(summarize)
    .sort((left, right) => right.lastUsedAt - left.lastUsedAt);
}

export function getRemoteBrowserSession(key: string): RemoteBrowserSessionSummary | null {
  const session = sessions.get(key);
  return session ? summarize(session) : null;
}

async function cdpPage(
  runtime: CdpRuntime,
  tabId?: number,
): Promise<{ page: Page; tabId: number }> {
  const id = tabId ?? runtime.activePageId ?? runtime.pagesById.keys().next().value;
  if (id == null) {
    const page = await runtime.context.newPage();
    const newId = registerPage(runtime, page);
    runtime.activePageId = newId;
    return { page, tabId: newId };
  }
  const page = runtime.pagesById.get(id);
  if (!page) throw new Error(`Remote tab ${id} was not found`);
  runtime.activePageId = id;
  return { page, tabId: id };
}

function targetSelector(
  runtime: CdpRuntime,
  tabId: number,
  target: BrowserElementTarget,
): string | null {
  if (target.selector) return target.selector;
  if (target.nodeIndex == null) return null;
  const snapshot = runtime.snapshotNodes.get(tabId);
  const page = runtime.pagesById.get(tabId);
  if (!snapshot || !page || snapshot.url !== page.url()) {
    runtime.snapshotNodes.delete(tabId);
    throw new Error("Snapshot handle expired; take a new snapshot");
  }
  return snapshot.nodes[target.nodeIndex]?.selector || null;
}

async function requiredElement(page: Page, selector: string): Promise<ElementHandle<Element>> {
  const element = await page.$(selector);
  if (!element) throw new Error(`Element not found: ${selector}`);
  return element;
}

function modifierKey(modifier: string): KeyInput {
  if (modifier === "ControlOrMeta") return process.platform === "darwin" ? "Meta" : "Control";
  return modifier as KeyInput;
}

async function withModifiers<T>(
  page: Page,
  modifiers: readonly string[] | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const keys = (modifiers || []).map(modifierKey);
  for (const key of keys) await page.keyboard.down(key);
  try {
    return await run();
  } finally {
    for (const key of [...keys].reverse()) await page.keyboard.up(key);
  }
}

async function takeCdpSnapshot(
  runtime: CdpRuntime,
  page: Page,
  tabId: number,
  options: BrowserToolInputMap["snapshot"],
) {
  const max = Math.min(1000, Math.max(1, options.maxNodes || 200));
  const nodes = await page.evaluate(
    ({ maxNodes, includeHidden }) => {
      const out: Array<BrowserSnapshotNode & { x: number; y: number }> = [];
      const selectorFor = (element: Element): string => {
        if (element === document.body) return "body";
        if (element.id) return `#${CSS.escape(element.id)}`;
        const path: string[] = [];
        let current: Element | null = element;
        while (current && current !== document.body) {
          const tag = current.tagName.toLowerCase();
          const parent: Element | null = current.parentElement;
          const siblings: Element[] = parent
            ? Array.from(parent.children).filter(
                (candidate) => candidate.tagName === current!.tagName,
              )
            : [];
          const suffix =
            siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : "";
          path.unshift(`${tag}${suffix}`);
          current = parent;
        }
        return `body > ${path.join(" > ")}`;
      };
      const walk = (element: Element, depth: number): void => {
        if (out.length >= maxNodes || depth > 8) return;
        const tag = element.tagName.toLowerCase();
        if (["script", "style", "noscript", "svg", "path"].includes(tag)) return;
        const role = element.getAttribute("role") || "";
        const html = element as HTMLElement;
        const name =
          element.getAttribute("aria-label") ||
          element.getAttribute("placeholder") ||
          (html.innerText || "").trim().slice(0, 100) ||
          element.getAttribute("name") ||
          element.getAttribute("href") ||
          "";
        const interactive =
          ["a", "button", "input", "textarea", "select", "option"].includes(tag) ||
          role === "button" ||
          html.onclick != null ||
          html.tabIndex >= 0;
        const rect = element.getBoundingClientRect();
        if (
          (interactive || name.length > 1) &&
          (includeHidden || (rect.width > 0 && rect.height > 0))
        ) {
          const input = element as HTMLInputElement;
          out.push({
            index: out.length,
            tag,
            role: role || undefined,
            name: name.slice(0, 100) || undefined,
            selector: selectorFor(element),
            disabled: "disabled" in input ? Boolean(input.disabled) : undefined,
            checked: "checked" in input ? Boolean(input.checked) : undefined,
            value: "value" in input ? String(input.value || "").slice(0, 200) : undefined,
            x: Math.round(rect.x + rect.width / 2),
            y: Math.round(rect.y + rect.height / 2),
          });
        }
        for (const child of Array.from(element.children)) walk(child, depth + 1);
      };
      if (document.body) walk(document.body, 0);
      return out;
    },
    { maxNodes: max, includeHidden: Boolean(options.includeHidden) },
  );
  runtime.snapshotNodes.set(tabId, { url: page.url(), nodes });
  return {
    ok: true as const,
    tab: await hydratedPageTab(runtime, page),
    snapshot: {
      title: await page.title(),
      url: page.url(),
      nodes,
      truncated: nodes.length >= max,
    },
  };
}

async function runCdpTool<Name extends BrowserToolName>(
  runtime: CdpRuntime,
  name: Name,
  args: BrowserToolInputMap[Name],
): Promise<BrowserToolResult<Name>> {
  if (name === "ping") {
    return {
      ok: true,
      mode: "cloud-cdp",
      ts: Date.now(),
      protocolVersion: BROWSER_PROTOCOL_VERSION,
    } as BrowserToolResult<Name>;
  }
  if (name === "tabs.list") {
    const tabs = await Promise.all(
      [...runtime.pagesById.values()].map((page) => hydratedPageTab(runtime, page)),
    );
    return toolResult<Name>({ ok: true, tabs });
  }
  if (name === "tabs.open") {
    const input = args as BrowserToolInputMap["tabs.open"];
    const page = await runtime.context.newPage();
    const tabId = registerPage(runtime, page);
    if (input.active !== false) runtime.activePageId = tabId;
    await page.goto(input.url);
    return { ok: true, tab: await hydratedPageTab(runtime, page) } as BrowserToolResult<Name>;
  }
  const input = args as BrowserToolInputMap[BrowserToolName];
  const resolved = await cdpPage(runtime, "tabId" in input ? input.tabId : undefined);
  const { page, tabId } = resolved;

  switch (name) {
    case "tabs.activate":
      await page.bringToFront();
      return { ok: true, tab: await hydratedPageTab(runtime, page) } as BrowserToolResult<Name>;
    case "tabs.close":
      await page.close();
      return { ok: true, tabId } as BrowserToolResult<Name>;
    case "navigate": {
      const value = args as BrowserToolInputMap["navigate"];
      if (value.newTab) {
        const next = await runtime.context.newPage();
        const nextId = registerPage(runtime, next);
        runtime.activePageId = nextId;
        await next.goto(value.url);
        return { ok: true, tab: await hydratedPageTab(runtime, next) } as BrowserToolResult<Name>;
      }
      await page.goto(value.url);
      runtime.snapshotNodes.delete(tabId);
      return { ok: true, tab: await hydratedPageTab(runtime, page) } as BrowserToolResult<Name>;
    }
    case "back":
      await page.goBack();
      return { ok: true, tab: await hydratedPageTab(runtime, page) } as BrowserToolResult<Name>;
    case "forward":
      await page.goForward();
      return { ok: true, tab: await hydratedPageTab(runtime, page) } as BrowserToolResult<Name>;
    case "reload":
      await page.reload();
      return { ok: true, tab: await hydratedPageTab(runtime, page) } as BrowserToolResult<Name>;
    case "snapshot":
      return toolResult<Name>(
        await takeCdpSnapshot(runtime, page, tabId, args as BrowserToolInputMap["snapshot"]),
      );
    case "find": {
      const value = args as BrowserToolInputMap["find"];
      const snapshot = await takeCdpSnapshot(runtime, page, tabId, { tabId, maxNodes: 1000 });
      const text = value.text?.toLowerCase();
      const role = value.role?.toLowerCase();
      const matches = snapshot.snapshot.nodes
        .filter((node) => {
          if (value.selector && node.selector !== value.selector) return false;
          if (text && !`${node.name || ""} ${node.text || ""}`.toLowerCase().includes(text))
            return false;
          if (role && (node.role || node.tag || "").toLowerCase() !== role) return false;
          return true;
        })
        .slice(0, value.limit || 20);
      return toolResult<Name>({ ok: true, tab: snapshot.tab, matches });
    }
    case "wait": {
      const value = args as BrowserToolInputMap["wait"];
      const started = Date.now();
      const timeout = value.timeoutMs || 30_000;
      if (value.selector) {
        const hidden = value.state === "hidden" || value.state === "gone";
        await page.waitForSelector(value.selector, {
          ...(hidden ? { hidden: true } : value.state === "attached" ? {} : { visible: true }),
          timeout,
        });
      } else if (value.text) {
        const expression = `(document.body?.innerText || "").includes(${JSON.stringify(value.text)})`;
        await page.waitForFunction(
          value.state === "hidden" || value.state === "gone" ? `!(${expression})` : expression,
          { timeout },
        );
      } else if (value.url) {
        await page.waitForFunction(`location.href === ${JSON.stringify(value.url)}`, { timeout });
      } else {
        throw new Error("wait requires selector, text, or url");
      }
      return {
        ok: true,
        matched: true,
        elapsedMs: Date.now() - started,
      } as BrowserToolResult<Name>;
    }
    case "click":
    case "dblclick":
    case "hover": {
      const value = args as BrowserToolInputMap["click"];
      const selector = targetSelector(runtime, tabId, value);
      if (selector) {
        const element = await requiredElement(page, selector);
        await withModifiers(page, value.modifiers, () =>
          name === "hover"
            ? element.hover()
            : element.click({
                button: value.button,
                count: name === "dblclick" ? 2 : value.clickCount,
              }),
        );
      } else if (value.x != null && value.y != null) {
        await withModifiers(page, value.modifiers, () =>
          name === "hover"
            ? page.mouse.move(value.x!, value.y!)
            : page.mouse.click(value.x!, value.y!, {
                count: name === "dblclick" ? 2 : value.clickCount,
              }),
        );
      } else {
        throw new Error(`${name} requires selector, nodeIndex, or x and y`);
      }
      return { ok: true, tabId } as BrowserToolResult<Name>;
    }
    case "focus": {
      const value = args as BrowserToolInputMap["focus"];
      const selector = targetSelector(runtime, tabId, value);
      if (!selector) throw new Error("focus requires selector or nodeIndex");
      await (await requiredElement(page, selector)).focus();
      return { ok: true, tabId } as BrowserToolResult<Name>;
    }
    case "type": {
      const value = args as BrowserToolInputMap["type"];
      const selector = targetSelector(runtime, tabId, value);
      const element = await requiredElement(page, selector || ":focus");
      await element.focus();
      if (value.clear !== false) {
        const selectAll = process.platform === "darwin" ? "Meta" : "Control";
        await page.keyboard.down(selectAll);
        await page.keyboard.press("a");
        await page.keyboard.up(selectAll);
        await page.keyboard.press("Backspace");
      }
      await element.type(value.text);
      if (value.submit) await element.press("Enter");
      return { ok: true, tabId } as BrowserToolResult<Name>;
    }
    case "press": {
      const value = args as BrowserToolInputMap["press"];
      const selector = targetSelector(runtime, tabId, value);
      const press = async () => {
        if (selector) await (await requiredElement(page, selector)).press(value.key as KeyInput);
        else await page.keyboard.press(value.key as KeyInput);
      };
      await withModifiers(page, value.modifiers, press);
      return { ok: true, tabId } as BrowserToolResult<Name>;
    }
    case "select": {
      const value = args as BrowserToolInputMap["select"];
      const selector = targetSelector(runtime, tabId, value);
      if (!selector) throw new Error("select requires selector or nodeIndex");
      const values = await (await requiredElement(page, selector)).select(...value.values);
      return toolResult<Name>({ ok: true, tabId, values });
    }
    case "check": {
      const value = args as BrowserToolInputMap["check"];
      const selector = targetSelector(runtime, tabId, value);
      if (!selector) throw new Error("check requires selector or nodeIndex");
      await (
        await requiredElement(page, selector)
      ).evaluate((element, checked) => {
        const input = element as HTMLInputElement;
        if (input.checked !== checked) input.click();
      }, value.checked);
      return { ok: true, tabId, checked: value.checked } as BrowserToolResult<Name>;
    }
    case "scroll": {
      const value = args as BrowserToolInputMap["scroll"];
      const selector = targetSelector(runtime, tabId, value);
      if (selector) {
        await (
          await requiredElement(page, selector)
        ).evaluate(
          (element, delta: { x: number; y: number }) => element.scrollBy(delta.x, delta.y),
          {
            x: value.deltaX ?? value.x ?? 0,
            y: value.deltaY ?? value.y ?? 0,
          },
        );
      } else if (value.x != null || value.y != null) {
        await page.evaluate(({ x, y }) => window.scrollTo(x, y), {
          x: value.x || 0,
          y: value.y || 0,
        });
      } else {
        await page.mouse.wheel({ deltaX: value.deltaX || 0, deltaY: value.deltaY || 0 });
      }
      return { ok: true, tabId } as BrowserToolResult<Name>;
    }
    case "screenshot": {
      const value = args as BrowserToolInputMap["screenshot"];
      const format = value.format || "jpeg";
      const bytes = await page.screenshot({
        type: format,
        fullPage: Boolean(value.fullPage),
        ...(format === "jpeg" ? { quality: value.quality || 80 } : {}),
      });
      const mime = format === "png" ? "image/png" : "image/jpeg";
      return {
        ok: true,
        tab: await hydratedPageTab(runtime, page),
        dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
        bytes: bytes.length,
        mime,
      } as BrowserToolResult<Name>;
    }
    case "upload": {
      const value = args as BrowserToolInputMap["upload"];
      const selector = targetSelector(runtime, tabId, value);
      if (!selector) throw new Error("upload requires selector or nodeIndex");
      const directory = await mkdtemp(join(tmpdir(), "executor-browser-upload-"));
      try {
        const paths: string[] = [];
        for (const [index, file] of value.files.entries()) {
          const path = join(directory, `${index}-${basename(file.name)}`);
          await writeFile(path, Buffer.from(file.dataBase64, "base64"));
          paths.push(path);
        }
        const input = (await requiredElement(page, selector)) as ElementHandle<HTMLInputElement>;
        await input.uploadFile(...paths);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
      return toolResult<Name>({ ok: true, tabId, files: value.files.map((file) => file.name) });
    }
    case "downloads.list": {
      const value = args as BrowserToolInputMap["downloads.list"];
      const downloads = runtime.downloads
        .filter((download) => !value.state || download.state === value.state)
        .slice(-(value.limit || 20));
      return toolResult<Name>({ ok: true, downloads });
    }
    case "dialog.handle": {
      const value = args as BrowserToolInputMap["dialog.handle"];
      const dialog = runtime.lastDialog;
      if (!dialog) throw new Error("No JavaScript dialog is pending");
      runtime.lastDialog = null;
      if (value.accept) await dialog.accept(value.promptText);
      else await dialog.dismiss();
      return { ok: true, handled: true } as BrowserToolResult<Name>;
    }
    case "console.list": {
      const value = args as BrowserToolInputMap["console.list"];
      const messages = runtime.console.filter(
        (entry) =>
          entry.tabId === tabId &&
          (!value.level || value.level === "all" || entry.level === value.level),
      );
      if (value.clear) {
        for (let index = runtime.console.length - 1; index >= 0; index--) {
          if (runtime.console[index]?.tabId === tabId) runtime.console.splice(index, 1);
        }
      }
      return toolResult<Name>({ ok: true, messages });
    }
    case "network.list": {
      const value = args as BrowserToolInputMap["network.list"];
      const filter = value.filter?.toLowerCase();
      const requests = runtime.network
        .filter(
          (entry) => entry.tabId === tabId && (!filter || entry.url.toLowerCase().includes(filter)),
        )
        .slice(-(value.limit || 100));
      if (value.clear) {
        for (let index = runtime.network.length - 1; index >= 0; index--) {
          if (runtime.network[index]?.tabId === tabId) runtime.network.splice(index, 1);
        }
      }
      return toolResult<Name>({ ok: true, requests });
    }
    case "evaluate": {
      const value = args as BrowserToolInputMap["evaluate"];
      const result = await page.evaluate(value.expression);
      return { ok: true, value: result, type: typeof result } as BrowserToolResult<Name>;
    }
    case "pdf": {
      const value = args as BrowserToolInputMap["pdf"];
      const bytes = await page.pdf({
        landscape: Boolean(value.landscape),
        printBackground: value.printBackground !== false,
      });
      return {
        ok: true,
        dataBase64: Buffer.from(bytes).toString("base64"),
        bytes: bytes.length,
        mime: "application/pdf",
      } as BrowserToolResult<Name>;
    }
    case "viewport.set": {
      const value = args as BrowserToolInputMap["viewport.set"];
      await page.setViewport({
        width: value.width,
        height: value.height,
        deviceScaleFactor: value.deviceScaleFactor || 1,
      });
      return {
        ok: true,
        width: value.width,
        height: value.height,
        deviceScaleFactor: value.deviceScaleFactor || 1,
      } as BrowserToolResult<Name>;
    }
    default:
      throw new Error(`Unsupported CDP browser tool: ${name}`);
  }
}

type AgentBrowserTab = {
  readonly tabId?: string;
  readonly title?: string;
  readonly url?: string;
  readonly active?: boolean;
};

function vercelNumericTab(session: RuntimeSession, ref: string): number {
  for (const [id, current] of session.vercelTabRefs) {
    if (current === ref) return id;
  }
  const id = session.nextVercelTabId++;
  session.vercelTabRefs.set(id, ref);
  return id;
}

function vercelTab(session: RuntimeSession, tab: AgentBrowserTab): BrowserTab {
  const ref = tab.tabId || `t${session.nextVercelTabId}`;
  const id = vercelNumericTab(session, ref);
  if (tab.active) session.activeVercelTabId = id;
  return {
    id,
    title: tab.title || "",
    url: tab.url || "",
    active: Boolean(tab.active),
    controlled: true,
  };
}

function vercelTabRef(session: RuntimeSession, tabId: unknown): string {
  const id = Number(tabId || session.activeVercelTabId || 1);
  const ref = session.vercelTabRefs.get(id);
  if (!ref) throw new Error(`Vercel browser tab ${id} was not found; list tabs first`);
  return ref;
}

function vercelTarget(session: RuntimeSession, args: Record<string, unknown>): string | null {
  if (typeof args.selector === "string") return args.selector;
  if (typeof args.nodeIndex === "number") {
    return session.vercelSnapshotRefs.get(args.nodeIndex) || null;
  }
  return null;
}

async function runVercelTool<Name extends BrowserToolName>(
  session: RuntimeSession,
  name: Name,
  args: BrowserToolInputMap[Name],
): Promise<BrowserToolResult<Name> | unknown> {
  const browser = session.handle.agentBrowser;
  if (!browser) throw new Error("Vercel browser command client is unavailable");
  const value = args as Record<string, unknown>;
  const json = async <T>(
    command: string,
    positional: string[] = [],
    flags?: Record<string, unknown>,
  ) => {
    const result = (await browser.exec<T>(command, {
      args: positional,
      flags,
      output: "json",
    })) as BrowserCommandResult<T>;
    if (!result.ok) throw new Error(result.stderr || result.stdout || `${command} failed`);
    return (result as unknown as { readonly data: T }).data;
  };
  const listTabs = async (): Promise<readonly BrowserTab[]> => {
    const data = await json<{ readonly tabs?: readonly AgentBrowserTab[] }>("tab");
    return (data.tabs || []).map((tab) => vercelTab(session, tab));
  };
  const currentTab = async (): Promise<BrowserTab> => {
    if (session.activeVercelTabId === null) await listTabs();
    return { id: session.activeVercelTabId || 1, active: true, controlled: true };
  };
  const snapshot = async (): Promise<
    Extract<BrowserToolResult<"snapshot">, { readonly ok: true }>
  > => {
    const data = await json<{
      readonly snapshot?: string;
      readonly refs?: Readonly<Record<string, { readonly role?: string; readonly name?: string }>>;
    }>("snapshot", [], { interactive: true });
    session.vercelSnapshotRefs.clear();
    const nodes = Object.entries(data.refs || {}).map(([ref, item], index) => {
      const selector = ref.startsWith("@") ? ref : `@${ref}`;
      session.vercelSnapshotRefs.set(index, selector);
      return {
        index,
        role: item.role,
        name: item.name,
        text: item.name,
        selector,
      } satisfies BrowserSnapshotNode;
    });
    return { ok: true, tab: await currentTab(), snapshot: { nodes } };
  };

  switch (name) {
    case "ping":
      return {
        ok: true,
        mode: "cloud-agent-browser",
        ts: Date.now(),
        protocolVersion: BROWSER_PROTOCOL_VERSION,
      };
    case "tabs.list":
      return { ok: true, tabs: await listTabs() };
    case "tabs.open": {
      const data = await json<AgentBrowserTab>("tab", ["new", String(value.url)]);
      const tab = vercelTab(session, { ...data, active: true });
      session.activeVercelTabId = tab.id;
      return { ok: true, tab };
    }
    case "tabs.activate": {
      const ref = vercelTabRef(session, value.tabId);
      const data = await json<AgentBrowserTab>("tab", [ref]);
      const tab = vercelTab(session, { ...data, tabId: data.tabId || ref, active: true });
      session.activeVercelTabId = tab.id;
      return { ok: true, tab };
    }
    case "tabs.close": {
      const id = Number(value.tabId);
      await browser.exec("tab", { args: ["close", vercelTabRef(session, id)] });
      session.vercelTabRefs.delete(id);
      if (session.activeVercelTabId === id) session.activeVercelTabId = null;
      return { ok: true, tabId: id };
    }
    case "navigate": {
      if (value.newTab) {
        const data = await json<AgentBrowserTab>("tab", ["new", String(value.url)]);
        const tab = vercelTab(session, { ...data, active: true });
        session.activeVercelTabId = tab.id;
        return { ok: true, tab };
      }
      if (value.tabId != null) {
        await browser.exec("tab", { args: [vercelTabRef(session, value.tabId)] });
        session.activeVercelTabId = Number(value.tabId);
      }
      await browser.exec("open", { args: [String(value.url)] });
      return { ok: true, tab: { ...(await currentTab()), url: String(value.url) } };
    }
    case "back":
    case "forward":
    case "reload":
      await browser.exec(name);
      return { ok: true, tab: await currentTab() };
    case "snapshot":
      return snapshot();
    case "find": {
      const result = await snapshot();
      const text = typeof value.text === "string" ? value.text.toLowerCase() : null;
      const role = typeof value.role === "string" ? value.role.toLowerCase() : null;
      return {
        ok: true,
        tab: result.tab,
        matches: result.snapshot.nodes
          .filter((node) => {
            if (typeof value.selector === "string" && node.selector !== value.selector)
              return false;
            if (text && !`${node.name || ""} ${node.text || ""}`.toLowerCase().includes(text))
              return false;
            return !role || (node.role || "").toLowerCase() === role;
          })
          .slice(0, Number(value.limit || 20)),
      };
    }
    case "wait": {
      const started = Date.now();
      const positional = value.selector
        ? [String(value.selector)]
        : value.text
          ? ["--text", String(value.text)]
          : ["--url", String(value.url)];
      await browser.exec("wait", {
        args: positional,
        timeoutMs: Number(value.timeoutMs || 30_000),
      });
      return { ok: true, matched: true, elapsedMs: Date.now() - started };
    }
    case "click":
    case "dblclick":
    case "hover":
    case "focus": {
      const target = vercelTarget(session, value);
      if (!target) throw new Error(`${name} requires selector or nodeIndex on Vercel Sandbox`);
      await browser.exec(name, { args: [target] });
      return { ok: true, tabId: Number(value.tabId || session.activeVercelTabId || 1) };
    }
    case "type": {
      const target = vercelTarget(session, value);
      if (!target) throw new Error("type requires selector or nodeIndex on Vercel Sandbox");
      await browser.exec(value.clear === false ? "type" : "fill", {
        args: [target, String(value.text)],
      });
      if (value.submit) await browser.exec("press", { args: ["Enter"] });
      return { ok: true, tabId: Number(value.tabId || session.activeVercelTabId || 1) };
    }
    case "press":
      await browser.exec("press", { args: [String(value.key)] });
      return { ok: true, tabId: Number(value.tabId || session.activeVercelTabId || 1) };
    case "select": {
      const target = vercelTarget(session, value);
      if (!target) throw new Error("select requires selector or nodeIndex on Vercel Sandbox");
      await browser.exec("select", { args: [target, ...(value.values as string[])] });
      return {
        ok: true,
        tabId: Number(value.tabId || session.activeVercelTabId || 1),
        values: value.values,
      };
    }
    case "check": {
      const target = vercelTarget(session, value);
      if (!target) throw new Error("check requires selector or nodeIndex on Vercel Sandbox");
      await browser.exec(value.checked ? "check" : "uncheck", { args: [target] });
      return {
        ok: true,
        tabId: Number(value.tabId || session.activeVercelTabId || 1),
        checked: Boolean(value.checked),
      };
    }
    case "scroll": {
      const vertical = Number(value.deltaY || value.y || 0);
      const horizontal = Number(value.deltaX || value.x || 0);
      const direction = vertical
        ? vertical < 0
          ? "up"
          : "down"
        : horizontal < 0
          ? "left"
          : "right";
      const target = vercelTarget(session, value);
      await browser.exec("scroll", {
        args: [direction, String(Math.abs(vertical || horizontal))],
        flags: target ? { selector: target } : undefined,
      });
      return { ok: true, tabId: Number(value.tabId || session.activeVercelTabId || 1) };
    }
    case "screenshot": {
      const capture = await browser.screenshot({ fullPage: Boolean(value.fullPage) });
      return {
        ok: true,
        tab: await currentTab(),
        dataUrl: `data:image/png;base64,${capture.png.toString("base64")}`,
        bytes: capture.png.length,
        mime: "image/png",
      };
    }
    case "upload": {
      const target = vercelTarget(session, value);
      if (!target) throw new Error("upload requires selector or nodeIndex on Vercel Sandbox");
      const files = value.files as BrowserToolInputMap["upload"]["files"];
      await browser.upload(
        target,
        files.map((file) => ({
          name: file.name,
          bytes: Buffer.from(file.dataBase64, "base64"),
        })),
      );
      return {
        ok: true,
        tabId: Number(value.tabId || session.activeVercelTabId || 1),
        files: files.map((file) => file.name),
      };
    }
    case "downloads.list":
      return { ok: true, downloads: [] };
    case "dialog.handle":
      await browser.exec("dialog", {
        args: value.accept
          ? ["accept", ...(value.promptText ? [String(value.promptText)] : [])]
          : ["dismiss"],
      });
      return { ok: true, handled: true };
    case "console.list": {
      const data = await json<{ readonly messages?: readonly Record<string, unknown>[] }>(
        "console",
      );
      return { ok: true, messages: data.messages || [] };
    }
    case "network.list": {
      const data = await json<{ readonly requests?: readonly Record<string, unknown>[] }>(
        "network",
        ["requests"],
        typeof value.filter === "string" ? { filter: value.filter } : undefined,
      );
      return { ok: true, requests: data.requests || [] };
    }
    case "evaluate":
      return { ok: true, value: await json("eval", [String(value.expression)]) };
    case "pdf": {
      const result = await browser.exec("pdf");
      if (!result.file) throw new Error("Vercel Sandbox did not return PDF bytes");
      return {
        ok: true,
        dataBase64: result.file.bytes.toString("base64"),
        bytes: result.file.bytes.length,
        mime: "application/pdf",
      };
    }
    case "viewport.set":
      await browser.exec("set", {
        args: [
          "viewport",
          String(value.width),
          String(value.height),
          String(value.deviceScaleFactor || 1),
        ],
      });
      return {
        ok: true,
        width: Number(value.width),
        height: Number(value.height),
        deviceScaleFactor: Number(value.deviceScaleFactor || 1),
      };
  }
}

export async function runRemoteBrowserTool<Name extends BrowserToolName>(input: {
  readonly key: string;
  readonly config: Exclude<BrowserIntegrationConfig, { provider: "local-extension" }>;
  readonly credential: string | null;
  readonly tool: Name;
  readonly args: BrowserToolInputMap[Name];
}): Promise<BrowserToolResult<Name> | unknown> {
  await startRemoteBrowserSession(input.key, input.config, input.credential);
  const session = sessions.get(input.key)!;
  session.lastUsedAt = Date.now();
  session.inFlight += 1;
  try {
    return await (session.cdp
      ? runCdpTool(session.cdp, input.tool, input.args)
      : runVercelTool(session, input.tool, input.args));
  } finally {
    session.inFlight -= 1;
    // The window runs from when the session was last finished with, not from
    // when the call started.
    session.lastUsedAt = Date.now();
  }
}
