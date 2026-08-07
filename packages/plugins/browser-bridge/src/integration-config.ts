/* oxlint-disable executor/no-switch-statement -- exhaustive provider config projection is a synchronous SDK boundary */

import type { AuthMethodDescriptor } from "@executor-js/sdk/shared";

import type { CloudBrowserProvider } from "./cloud-providers";
import { normalizeHost, type RemoteHostPolicy } from "./host-policy";

export type BrowserProvider = "local-extension" | CloudBrowserProvider;

/**
 * Controls every remote target carries, and the local extension does not.
 *
 * The local browser is the user's own signed-in Chrome, governed by the
 * extension's own settings. A remote target is a rented, isolated browser, so
 * its limits are stored with the integration instead.
 */
type RemoteTargetControls = {
  /**
   * How long an idle session is kept before it is closed. Remote browsers bill
   * for wall-clock time, so this is what stops an abandoned session from
   * becoming a standing charge.
   */
  readonly idleTimeoutMs?: number;
  /**
   * Whether the Advanced tools (evaluate, pdf, console, network, dialogs,
   * viewport) are available. Defaults to on: unlike the local extension, a
   * remote browser holds no personal session to protect. Set false to withhold
   * them from the catalog entirely.
   */
  readonly allowAdvanced?: boolean;
  /**
   * The hosts this target may reach. Empty means any public host.
   *
   * The local extension has had this since it existed; a remote target had
   * nothing, so the only limit on where it could be sent was a person
   * approving each action one at a time. Setting it is also what lets those
   * approvals collapse into one per session, since a bounded target no longer
   * needs a human reading every URL.
   */
  readonly allowedHosts?: readonly string[];
  /**
   * Whether this target may reach private and link-local addresses.
   *
   * Off unless asked for. A browser that can be pointed at an address is a
   * request forger, and `169.254.169.254` hands out cloud credentials to
   * anything that asks. Turn it on only for a target aimed at an internal app,
   * and pair it with an allowlist.
   */
  readonly allowPrivateNetwork?: boolean;
  /**
   * Approve the session instead of every action, on a target with no allowlist.
   *
   * The local extension has the same idea as its "full access" mode, and the
   * same reason to allow it: what makes per-action approval necessary is not
   * knowing where the browser will be sent, and someone who has decided they do
   * not need to know each time should be able to say so once rather than
   * clicking through prompts they have stopped reading.
   *
   * It is not a permanent grant. Approval is asked at session start, and a
   * session is closed once it has been idle for `idleTimeoutMs`, so the next
   * one asks again. Private addresses are still refused, and sensitive tools
   * still ask.
   */
  readonly fullAccess?: boolean;
};

export type BrowserIntegrationConfig =
  | {
      readonly provider: "local-extension";
      readonly transport: "reverse";
      readonly kind: "extension";
      /**
       * Approve the extension's session rather than each action.
       *
       * Stored here rather than read from whatever the extension is currently
       * advertising, because the tool catalog carrying these approvals is
       * cached and only rebuilt when config changes. An approval rule derived
       * from the extension's live mode would keep applying after that mode
       * changed, which is the one way this could quietly grant more than was
       * agreed.
       *
       * Honoured only while the extension is in Limited mode, checked at call
       * time where the answer is live. Full access plus no per-action prompt is
       * the user's whole signed-in Chrome behind a single click.
       */
      readonly sessionScopedApproval?: boolean;
    }
  | (RemoteTargetControls & {
      readonly provider: "vercel-sandbox";
      readonly timeoutMs?: number;
      readonly vcpus?: number;
      readonly image?: string;
      readonly args?: readonly string[];
      /**
       * How the sandbox authenticates. `token` reads a Vercel API token from
       * this target's connection; `ambient` relies on the Executor host's own
       * Vercel identity, which only exists when Executor runs on Vercel or
       * something has put VERCEL_OIDC_TOKEN in the server's environment.
       */
      readonly auth?: "token" | "ambient";
      readonly teamId?: string;
      readonly projectId?: string;
    })
  | (RemoteTargetControls & {
      readonly provider: "cloudflare-browser-run";
      readonly accountId: string;
      readonly keepAliveMs?: number;
    })
  | (RemoteTargetControls & {
      readonly provider: "browser-use";
      readonly timeoutMinutes?: number;
      readonly profileId?: string;
      readonly proxyCountryCode?: string | null;
      readonly enableRecording?: boolean;
    })
  | (RemoteTargetControls & {
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
    });

export const LOCAL_BROWSER_CONFIG: BrowserIntegrationConfig = {
  provider: "local-extension",
  transport: "reverse",
  kind: "extension",
};

function remoteControls(config: Record<string, unknown>): RemoteTargetControls {
  const hosts = Array.isArray(config.allowedHosts)
    ? config.allowedHosts
        .filter((host): host is string => typeof host === "string")
        .map(normalizeHost)
        .filter(Boolean)
    : [];
  return {
    ...(typeof config.idleTimeoutMs === "number" ? { idleTimeoutMs: config.idleTimeoutMs } : {}),
    ...(typeof config.allowAdvanced === "boolean" ? { allowAdvanced: config.allowAdvanced } : {}),
    ...(hosts.length ? { allowedHosts: hosts } : {}),
    ...(config.allowPrivateNetwork === true ? { allowPrivateNetwork: true } : {}),
    ...(config.fullAccess === true ? { fullAccess: true } : {}),
  };
}

/**
 * The access policy for a target, in the shape the host check takes.
 *
 * The local extension carries its own policy in its own settings, so it never
 * reaches here; a config with no remote controls is treated as unbounded,
 * which is what an existing target that predates this field is.
 */
export function hostPolicyFor(config: BrowserIntegrationConfig): RemoteHostPolicy {
  if (config.provider === "local-extension") return {};
  return {
    ...(config.allowedHosts ? { allowedHosts: config.allowedHosts } : {}),
    ...(config.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
  };
}

/** Whether a target is held to a named set of hosts. */
export function targetIsBounded(config: BrowserIntegrationConfig): boolean {
  return config.provider !== "local-extension" && (config.allowedHosts?.length || 0) > 0;
}

/**
 * Whether approving the session stands in for approving each action.
 *
 * True by two different routes, which are worth keeping distinct. A bounded
 * target earns it: the destinations are known in advance, so there is nothing
 * left for a per-action prompt to decide. An unbounded one is granted it: the
 * destinations are not known, and someone has said they do not need to see each
 * one. Both are session-scoped and both name their scope at the prompt.
 */
export function approvalIsSessionScoped(config: BrowserIntegrationConfig): boolean {
  if (config.provider === "local-extension") return false;
  return targetIsBounded(config) || config.fullAccess === true;
}

/** What a session approval is actually agreeing to, in one phrase. */
export function sessionApprovalScope(config: BrowserIntegrationConfig): string {
  if (config.provider === "local-extension") return "";
  const hosts = config.allowedHosts || [];
  const where = hosts.length ? `limited to ${hosts.join(", ")}` : "able to visit any public site";
  const privately = config.allowPrivateNetwork
    ? ", including private addresses on your network"
    : "";
  return `${where}${privately}`;
}

export function parseBrowserIntegrationConfig(value: unknown): BrowserIntegrationConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const config = value as Record<string, unknown>;
  if (
    config.provider === "local-extension" ||
    // Backward compatibility for the original extension integration.
    (config.transport === "reverse" && config.kind === "extension")
  ) {
    return {
      provider: "local-extension",
      transport: "reverse",
      kind: "extension",
      ...(config.sessionScopedApproval === true ? { sessionScopedApproval: true } : {}),
    };
  }

  if (config.provider === "vercel-sandbox") {
    return {
      provider: config.provider,
      ...remoteControls(config),
      ...(typeof config.timeoutMs === "number" ? { timeoutMs: config.timeoutMs } : {}),
      ...(typeof config.vcpus === "number" ? { vcpus: config.vcpus } : {}),
      ...(typeof config.image === "string" ? { image: config.image } : {}),
      ...(config.auth === "token" || config.auth === "ambient" ? { auth: config.auth } : {}),
      ...(typeof config.teamId === "string" ? { teamId: config.teamId } : {}),
      ...(typeof config.projectId === "string" ? { projectId: config.projectId } : {}),
      ...(Array.isArray(config.args) && config.args.every((arg) => typeof arg === "string")
        ? { args: config.args }
        : {}),
    };
  }
  if (config.provider === "cloudflare-browser-run" && typeof config.accountId === "string") {
    return {
      provider: config.provider,
      accountId: config.accountId,
      ...remoteControls(config),
      ...(typeof config.keepAliveMs === "number" ? { keepAliveMs: config.keepAliveMs } : {}),
    };
  }
  if (config.provider === "browser-use") {
    return {
      provider: config.provider,
      ...remoteControls(config),
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
      ...remoteControls(config),
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
      return [{ id: "none", label: "No account secret", kind: "none", template: "none" }];
    case "vercel-sandbox":
      // The token is handed to the Vercel SDK rather than placed on a request
      // by us, so this declares the secret without a carrier placement.
      return config.auth === "token"
        ? [
            {
              id: "api-token",
              label: "Vercel API token",
              kind: "apikey",
              template: "api-token",
            },
          ]
        : [{ id: "none", label: "No account secret", kind: "none", template: "none" }];
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
