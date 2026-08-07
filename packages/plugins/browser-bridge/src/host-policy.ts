/**
 * Where a remote browser is allowed to go.
 *
 * A local browser runs on a machine someone is sitting at, inside an extension
 * that already refuses hosts outside its configured scope. A remote browser has
 * neither. It runs in a provider's network, and until now the only thing
 * standing between a tool call and any URL on the internet was a human clicking
 * approve on each individual action.
 *
 * Two rules, in this order.
 *
 * Private address space is refused whatever the allowlist says, unless a target
 * deliberately opts in. A browser that can be pointed at an address is a
 * request forger: `169.254.169.254` hands out cloud credentials, and a private
 * range reaches whatever the provider's network happens to touch. This is the
 * rule that matters even when someone has left the allowlist empty.
 *
 * The allowlist is then applied if there is one. An empty list means any public
 * host, which keeps a target usable for open-ended browsing; the point of the
 * list is that a target which only ever needs two domains can be held to them.
 *
 * A known limit: a name is checked, not the address it resolves to. A public
 * hostname pointing at a private address passes this and is stopped only by the
 * provider's own network. Recording it because a check that looks complete and
 * is not is worse than one whose edges are written down.
 */

export type RemoteHostPolicy = {
  /** Empty or absent means any public host. */
  readonly allowedHosts?: readonly string[];
  /** Opt in to private address space, for targets pointed at an internal app. */
  readonly allowPrivateNetwork?: boolean;
};

export type HostVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

const ALLOWED = { allowed: true } as const;

/** Blank pages are the browser's own, not a destination. */
const BLANK = new Set(["about:blank", "about:srcdoc"]);

/**
 * Hostnames that name a machine rather than a site.
 *
 * `metadata.google.internal` is listed by name because it resolves to a
 * link-local address that a URL string never shows.
 */
const PRIVATE_NAMES = new Set(["localhost", "metadata.google.internal", "metadata"]);
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

export function checkRemoteUrl(raw: string, policy: RemoteHostPolicy = {}): HostVerdict {
  const trimmed = String(raw || "").trim();
  if (BLANK.has(trimmed.toLowerCase())) return ALLOWED;

  const url = URL.parse(trimmed);
  if (!url) return { allowed: false, reason: `"${clip(trimmed)}" is not a URL` };
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    // file: reads the provider's disk and data: carries its own payload, and
    // neither is a place a browsing target needs to be sent.
    return { allowed: false, reason: `Only http and https URLs are allowed, not ${url.protocol}` };
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!policy.allowPrivateNetwork && isPrivateHost(host)) {
    return {
      allowed: false,
      reason: `${host} is a private or link-local address, which this browser target may not reach`,
    };
  }

  const allowed = (policy.allowedHosts || []).map(normalizeHost).filter(Boolean);
  if (allowed.length === 0) return ALLOWED;
  // Same rule the local extension applies: an entry covers the host itself and
  // anything under it, so "example.com" reaches www.example.com without also
  // reaching notexample.com.
  const permitted = allowed.some((entry) => host === entry || host.endsWith(`.${entry}`));
  return permitted
    ? ALLOWED
    : {
        allowed: false,
        reason: `${host} is outside this browser target's allowed hosts (${allowed.join(", ")})`,
      };
}

/** A host entry as stored: bare hostname, lowercased, no scheme, port, or path. */
export function normalizeHost(entry: string): string {
  const text = String(entry || "")
    .trim()
    .toLowerCase();
  if (!text) return "";
  const withScheme = text.includes("://") ? text : `https://${text}`;
  const parsed = URL.parse(withScheme);
  // A leading dot is how allowlists are often written; it means the same thing
  // here, so it is accepted rather than silently matching nothing.
  return (parsed?.hostname || text).replace(/^\.+/, "");
}

export function isPrivateHost(host: string): boolean {
  if (!host) return true;
  if (PRIVATE_NAMES.has(host)) return true;
  if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  // A bare name with no dot is a machine on the local network, not a site.
  if (!host.includes(".") && !host.includes(":")) return true;

  const v4 = ipv4Octets(host);
  if (v4) return isPrivateIpv4(v4);
  if (host.includes(":")) return isPrivateIpv6(host);
  return false;
}

function ipv4Octets(host: string): readonly number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : -1));
  return octets.every((value) => value >= 0 && value <= 255) ? octets : null;
}

/**
 * The IPv4 address inside an IPv6 one, if there is one.
 *
 * Both spellings have to be read. `URL` rewrites `::ffff:169.254.169.254` into
 * `::ffff:a9fe:a9fe`, so a check that only looked for dotted quads let the
 * metadata address through in the shape an attacker would actually type.
 */
function ipv4FromMapped(address: string): readonly number[] | null {
  const dotted = address.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted?.[1]) return ipv4Octets(dotted[1]);
  const hex = address.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hex?.[1] || !hex[2]) return null;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return [high >>> 8, high & 255, low >>> 8, low & 255];
}

function isPrivateIpv4(octets: readonly number[]): boolean {
  const [a = 0, b = 0] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local, and cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return a >= 224; // multicast and reserved
}

function isPrivateIpv6(host: string): boolean {
  const address = host.split("%")[0] || "";
  if (address === "::1" || address === "::") return true;
  const mapped = ipv4FromMapped(address);
  if (mapped && isPrivateIpv4(mapped)) return true;
  const head = address.slice(0, 4).toLowerCase();
  if (
    head.startsWith("fe8") ||
    head.startsWith("fe9") ||
    head.startsWith("fea") ||
    head.startsWith("feb")
  ) {
    return true; // link-local
  }
  return head.startsWith("fc") || head.startsWith("fd"); // unique local
}

function clip(text: string): string {
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}
