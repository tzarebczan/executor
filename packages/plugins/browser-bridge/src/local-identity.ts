import { connectionIdentifier, isConnectionIdentifier } from "@executor-js/sdk/core";

/** Backward-compatible connection for the first unlabeled Chrome. */
export const DEFAULT_LOCAL_CONNECTION = "desktop";

export type LocalBrowserIdentity = {
  readonly instanceId?: string;
  readonly browser?: string;
  readonly label?: string;
  readonly requestedConnection?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Identity the extension advertised when it opened the reverse session.
 *
 * Read from `client` and `connection` rather than a third top-level field, so a
 * current extension and an older one that only sent `connection.name: "desktop"`
 * go through the same parser.
 */
export function parseLocalBrowserIdentity(input: {
  readonly client?: unknown;
  readonly connection?: unknown;
}): LocalBrowserIdentity {
  const client = asRecord(input.client);
  const connection = asRecord(input.connection);
  return {
    ...(readString(client?.instanceId) ? { instanceId: readString(client?.instanceId) } : {}),
    ...(readString(client?.browser) ? { browser: readString(client?.browser) } : {}),
    ...(readString(client?.label) ? { label: readString(client?.label) } : {}),
    ...(readString(connection?.name) ? { requestedConnection: readString(connection?.name) } : {}),
  };
}

export function slugConnectionName(raw: string): string {
  const slug = String(connectionIdentifier(raw, DEFAULT_LOCAL_CONNECTION));
  return isConnectionIdentifier(slug) ? slug : DEFAULT_LOCAL_CONNECTION;
}

function isChromeFamily(browser?: string): boolean {
  if (!browser) return true;
  const name = browser.toLowerCase();
  return name === "chrome" || name === "chromium";
}

/**
 * The name this browser would like, before collisions.
 *
 * Chrome without a label stays `desktop` so existing agents calling
 * `tools.browser.user.desktop` keep working. A second browser, or a label, gets
 * a name of its own.
 */
export function preferredConnectionName(identity: LocalBrowserIdentity): string {
  const requested = identity.requestedConnection;
  if (requested && requested !== DEFAULT_LOCAL_CONNECTION) {
    return slugConnectionName(requested);
  }
  if (identity.label) return slugConnectionName(identity.label);
  if (isChromeFamily(identity.browser)) return DEFAULT_LOCAL_CONNECTION;
  return slugConnectionName(identity.browser || DEFAULT_LOCAL_CONNECTION);
}

function uniquifyBase(identity: LocalBrowserIdentity, preferred: string): string {
  if (identity.label) return slugConnectionName(identity.label);
  if (identity.browser) return slugConnectionName(identity.browser);
  return preferred === DEFAULT_LOCAL_CONNECTION ? "chrome" : preferred;
}

/**
 * Pick a connection name that no other live session of this user already has.
 *
 * Reconnects of the same instance keep their existing name in the store; this
 * only runs for a browser that does not yet have one.
 */
export function allocateConnectionName(
  identity: LocalBrowserIdentity,
  taken: readonly string[],
): string {
  const takenSet = new Set(taken);
  const preferred = preferredConnectionName(identity);
  if (!takenSet.has(preferred)) return preferred;
  const base = uniquifyBase(identity, preferred);
  if (!takenSet.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}${n}`;
    if (!takenSet.has(candidate)) return candidate;
  }
  return `${base}${Date.now().toString(36)}`;
}

export function localToolAddress(connectionName: string): string {
  return `tools.browser.user.${connectionName}`;
}

export function localBrowserDisplayName(identity: {
  readonly label?: string;
  readonly browser?: string;
  readonly connectionName?: string;
}): string {
  return identity.label || identity.browser || identity.connectionName || "Local Chrome";
}
