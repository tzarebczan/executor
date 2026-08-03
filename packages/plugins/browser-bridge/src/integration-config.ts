/* oxlint-disable executor/no-switch-statement -- exhaustive provider config projection is a synchronous SDK boundary */

import type { AuthMethodDescriptor } from "@executor-js/sdk/shared";

import type { CloudBrowserProvider } from "./cloud-providers";

export type BrowserProvider = "local-extension" | CloudBrowserProvider;

export type BrowserIntegrationConfig =
  | {
      readonly provider: "local-extension";
      readonly transport: "reverse";
      readonly kind: "extension";
    }
  | {
      readonly provider: "vercel-sandbox";
      readonly timeoutMs?: number;
      readonly vcpus?: number;
      readonly image?: string;
      readonly args?: readonly string[];
    }
  | {
      readonly provider: "cloudflare-browser-run";
      readonly accountId: string;
      readonly keepAliveMs?: number;
    }
  | {
      readonly provider: "browser-use";
      readonly timeoutMinutes?: number;
      readonly profileId?: string;
      readonly proxyCountryCode?: string | null;
      readonly enableRecording?: boolean;
    }
  | {
      readonly provider: "generic-cdp";
      readonly cdpUrl: string;
      readonly liveUrl?: string;
      readonly auth?:
        | { readonly kind: "none" }
        | {
            readonly kind: "header";
            readonly headerName: string;
            readonly prefix?: string;
          };
    };

export const LOCAL_BROWSER_CONFIG: BrowserIntegrationConfig = {
  provider: "local-extension",
  transport: "reverse",
  kind: "extension",
};

export function parseBrowserIntegrationConfig(value: unknown): BrowserIntegrationConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const config = value as Record<string, unknown>;
  if (config.provider === "local-extension") return LOCAL_BROWSER_CONFIG;
  // Backward compatibility for the original extension integration.
  if (config.transport === "reverse" && config.kind === "extension") return LOCAL_BROWSER_CONFIG;

  if (config.provider === "vercel-sandbox") {
    return {
      provider: config.provider,
      ...(typeof config.timeoutMs === "number" ? { timeoutMs: config.timeoutMs } : {}),
      ...(typeof config.vcpus === "number" ? { vcpus: config.vcpus } : {}),
      ...(typeof config.image === "string" ? { image: config.image } : {}),
      ...(Array.isArray(config.args) && config.args.every((arg) => typeof arg === "string")
        ? { args: config.args }
        : {}),
    };
  }
  if (config.provider === "cloudflare-browser-run" && typeof config.accountId === "string") {
    return {
      provider: config.provider,
      accountId: config.accountId,
      ...(typeof config.keepAliveMs === "number" ? { keepAliveMs: config.keepAliveMs } : {}),
    };
  }
  if (config.provider === "browser-use") {
    return {
      provider: config.provider,
      ...(typeof config.timeoutMinutes === "number"
        ? { timeoutMinutes: config.timeoutMinutes }
        : {}),
      ...(typeof config.profileId === "string" ? { profileId: config.profileId } : {}),
      ...(typeof config.proxyCountryCode === "string" || config.proxyCountryCode === null
        ? { proxyCountryCode: config.proxyCountryCode as string | null }
        : {}),
      ...(typeof config.enableRecording === "boolean"
        ? { enableRecording: config.enableRecording }
        : {}),
    };
  }
  if (config.provider === "generic-cdp" && typeof config.cdpUrl === "string") {
    const rawAuth = config.auth;
    let auth: Extract<BrowserIntegrationConfig, { provider: "generic-cdp" }>["auth"];
    if (rawAuth && typeof rawAuth === "object" && !Array.isArray(rawAuth)) {
      const candidate = rawAuth as Record<string, unknown>;
      if (candidate.kind === "none") auth = { kind: "none" };
      if (candidate.kind === "header" && typeof candidate.headerName === "string") {
        auth = {
          kind: "header",
          headerName: candidate.headerName,
          ...(typeof candidate.prefix === "string" ? { prefix: candidate.prefix } : {}),
        };
      }
    }
    return {
      provider: config.provider,
      cdpUrl: config.cdpUrl,
      ...(typeof config.liveUrl === "string" ? { liveUrl: config.liveUrl } : {}),
      ...(auth ? { auth } : {}),
    };
  }
  return null;
}

export function browserProviderName(provider: BrowserProvider): string {
  switch (provider) {
    case "local-extension":
      return "Local Chrome";
    case "vercel-sandbox":
      return "Vercel Sandbox";
    case "cloudflare-browser-run":
      return "Cloudflare Browser Rendering";
    case "browser-use":
      return "Browser Use";
    case "generic-cdp":
      return "Generic CDP";
  }
}

export function browserAuthMethods(
  config: BrowserIntegrationConfig,
): readonly AuthMethodDescriptor[] {
  switch (config.provider) {
    case "local-extension":
    case "vercel-sandbox":
      return [{ id: "none", label: "No account secret", kind: "none", template: "none" }];
    case "cloudflare-browser-run":
      return [
        {
          id: "api-token",
          label: "Cloudflare API token",
          kind: "apikey",
          template: "api-token",
          placements: [
            { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "token" },
          ],
        },
      ];
    case "browser-use":
      return [
        {
          id: "api-key",
          label: "Browser Use API key",
          kind: "apikey",
          template: "api-key",
          placements: [
            { carrier: "header", name: "x-browser-use-api-key", prefix: "", variable: "token" },
          ],
        },
      ];
    case "generic-cdp":
      return config.auth?.kind === "header"
        ? [
            {
              id: "header",
              label: `${config.auth.headerName} value`,
              kind: "header",
              template: "header",
              placements: [
                {
                  carrier: "header",
                  name: config.auth.headerName,
                  prefix: config.auth.prefix || "",
                  variable: "token",
                },
              ],
            },
          ]
        : [{ id: "none", label: "No authentication", kind: "none", template: "none" }];
  }
}

export function browserProviderDefaultSlug(
  provider: Exclude<BrowserProvider, "local-extension">,
): string {
  switch (provider) {
    case "vercel-sandbox":
      return "browser-vercel";
    case "cloudflare-browser-run":
      return "browser-cloudflare";
    case "browser-use":
      return "browser-use";
    case "generic-cdp":
      return "browser-cdp";
  }
}
