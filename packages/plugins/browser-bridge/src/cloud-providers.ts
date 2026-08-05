/* oxlint-disable executor/no-promise-catch, executor/no-try-catch-or-throw, executor/no-error-constructor -- provider SDK and fetch adapter boundary normalizes third-party failures */

import { AgentBrowser, type BrowserCommandResult } from "remote-agent-browser";

import { createTokenVercelBrowser } from "./vercel-token-browser";

export type CloudBrowserProvider =
  | "vercel-sandbox"
  | "cloudflare-browser-run"
  | "browser-use"
  | "generic-cdp";

export interface CloudBrowserSession {
  readonly provider: CloudBrowserProvider;
  readonly sessionId: string;
  readonly transport: "agent-browser" | "cdp";
  readonly cdpUrl?: string;
  readonly liveUrl?: string;
  readonly recordingUrl?: string;
  readonly expiresAt?: string;
}

export type CloudBrowserProviderConfig =
  | {
      readonly provider: "vercel-sandbox";
      readonly timeoutMs?: number;
      readonly vcpus?: number;
      readonly image?: string;
      readonly args?: readonly string[];
      /**
       * A Vercel API token. When present the sandbox is provisioned with it
       * instead of the host's ambient OIDC identity, which is the difference
       * between "works anywhere Executor runs" and "works only on Vercel".
       */
      readonly token?: string;
      readonly teamId?: string;
      readonly projectId?: string;
    }
  | {
      readonly provider: "cloudflare-browser-run";
      readonly accountId: string;
      readonly apiToken: string;
      readonly keepAliveMs?: number;
    }
  | {
      readonly provider: "browser-use";
      readonly apiKey: string;
      readonly timeoutMinutes?: number;
      readonly profileId?: string;
      readonly proxyCountryCode?: string | null;
      readonly enableRecording?: boolean;
    }
  | {
      readonly provider: "generic-cdp";
      readonly cdpUrl: string;
      readonly liveUrl?: string;
      readonly headers?: Readonly<Record<string, string>>;
    };

export interface CloudBrowserHandle {
  readonly session: CloudBrowserSession;
  readonly connectionHeaders?: Readonly<Record<string, string>>;
  readonly agentBrowser?: AgentBrowser;
  run?(command: string, args?: readonly string[]): Promise<BrowserCommandResult>;
  close(): Promise<void>;
}

export const CLOUD_BROWSER_PROVIDERS = [
  {
    id: "vercel-sandbox",
    name: "Vercel Sandbox",
    transport: "agent-browser",
    package: "remote-agent-browser",
  },
  {
    id: "cloudflare-browser-run",
    name: "Cloudflare Browser Run",
    transport: "cdp",
  },
  { id: "browser-use", name: "Browser Use", transport: "cdp" },
  {
    id: "generic-cdp",
    name: "Generic CDP",
    transport: "cdp",
    note: "Browserbase, Browserless, Kernel, and compatible endpoints",
  },
] as const;

type ProviderDependencies = {
  readonly fetch?: typeof globalThis.fetch;
  readonly createVercelBrowser?: typeof AgentBrowser.create;
  readonly createTokenVercelBrowser?: typeof createTokenVercelBrowser;
};

async function jsonRequest(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, init);
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const detail = body.detail || body.error || body.message || response.statusText;
    throw new Error(`Cloud browser request failed (${response.status}): ${String(detail)}`);
  }
  return body;
}

export async function createCloudBrowserSession(
  config: CloudBrowserProviderConfig,
  dependencies: ProviderDependencies = {},
): Promise<CloudBrowserHandle> {
  const fetchImpl = dependencies.fetch || globalThis.fetch;

  if (config.provider === "vercel-sandbox") {
    // A stored token wins over the ambient identity: it was chosen explicitly,
    // and it is the only path that works when Executor does not run on Vercel.
    if (config.token && (!config.teamId || !config.projectId)) {
      throw new Error(
        "Vercel Team ID and Project ID are required when a browser target uses an API token",
      );
    }
    const browser = config.token
      ? await (dependencies.createTokenVercelBrowser || createTokenVercelBrowser)({
          token: config.token,
          teamId: config.teamId!,
          projectId: config.projectId!,
          timeoutMs: config.timeoutMs,
          vcpus: config.vcpus,
          image: config.image,
          args: config.args,
        })
      : await (dependencies.createVercelBrowser || AgentBrowser.create)({
          timeoutMs: config.timeoutMs,
          vcpus: config.vcpus,
          image: config.image,
          args: config.args ? [...config.args] : undefined,
        });
    return {
      session: {
        provider: config.provider,
        sessionId: browser.session,
        transport: "agent-browser",
      },
      agentBrowser: browser,
      run: (command, args = []) => browser.exec(command, { args: [...args] }),
      close: () => browser.close(),
    };
  }

  if (config.provider === "cloudflare-browser-run") {
    const keepAlive = Math.min(1_200_000, Math.max(10_000, config.keepAliveMs || 600_000));
    const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/browser-rendering/devtools/browser`;
    const body = await jsonRequest(fetchImpl, `${base}?keep_alive=${keepAlive}&targets=true`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiToken}` },
    });
    const sessionId = String(body.sessionId || "");
    const cdpUrl = String(body.webSocketDebuggerUrl || "");
    const targets = Array.isArray(body.targets) ? body.targets : [];
    const liveUrl = targets.find(
      (target): target is { readonly devtoolsFrontendUrl: string } =>
        typeof target === "object" &&
        target !== null &&
        "devtoolsFrontendUrl" in target &&
        typeof target.devtoolsFrontendUrl === "string",
    )?.devtoolsFrontendUrl;
    if (!sessionId || !cdpUrl) throw new Error("Cloudflare did not return a CDP session");
    return {
      session: {
        provider: config.provider,
        sessionId,
        transport: "cdp",
        cdpUrl,
        liveUrl,
      },
      connectionHeaders: { authorization: `Bearer ${config.apiToken}` },
      close: async () => {
        await jsonRequest(fetchImpl, `${base}/${encodeURIComponent(sessionId)}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${config.apiToken}` },
        });
      },
    };
  }

  if (config.provider === "browser-use") {
    const body = await jsonRequest(fetchImpl, "https://api.browser-use.com/api/v3/browsers", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-browser-use-api-key": config.apiKey,
      },
      body: JSON.stringify({
        timeout: Math.min(240, Math.max(1, config.timeoutMinutes || 60)),
        ...(config.profileId ? { profileId: config.profileId } : {}),
        ...(config.proxyCountryCode !== undefined
          ? { proxyCountryCode: config.proxyCountryCode }
          : {}),
        enableRecording: Boolean(config.enableRecording),
      }),
    });
    const sessionId = String(body.id || "");
    const cdpUrl = String(body.cdpUrl || "");
    if (!sessionId || !cdpUrl) throw new Error("Browser Use did not return a CDP session");
    const headers = { "x-browser-use-api-key": config.apiKey };
    return {
      session: {
        provider: config.provider,
        sessionId,
        transport: "cdp",
        cdpUrl,
        liveUrl: typeof body.liveUrl === "string" ? body.liveUrl : undefined,
        recordingUrl: typeof body.recordingUrl === "string" ? body.recordingUrl : undefined,
        expiresAt: typeof body.timeoutAt === "string" ? body.timeoutAt : undefined,
      },
      connectionHeaders: headers,
      close: async () => {
        await jsonRequest(
          fetchImpl,
          `https://api.browser-use.com/api/v3/browsers/${encodeURIComponent(sessionId)}`,
          {
            method: "PATCH",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ action: "stop" }),
          },
        );
      },
    };
  }

  const sessionId = `cdp-${crypto.randomUUID()}`;
  return {
    session: {
      provider: config.provider,
      sessionId,
      transport: "cdp",
      cdpUrl: config.cdpUrl,
      liveUrl: config.liveUrl,
    },
    connectionHeaders: config.headers,
    close: async () => {},
  };
}
