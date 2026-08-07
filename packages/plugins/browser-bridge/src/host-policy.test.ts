import { describe, expect, it } from "@effect/vitest";

import { checkRemoteUrl, isPrivateHost, normalizeHost } from "./host-policy";

const allowed = (url: string, policy = {}) => checkRemoteUrl(url, policy).allowed;
const reason = (url: string, policy = {}) => {
  const verdict = checkRemoteUrl(url, policy);
  return verdict.allowed ? "" : verdict.reason;
};

describe("checkRemoteUrl", () => {
  it("allows any public host when no allowlist is configured", () => {
    // An empty list keeps a target usable for open-ended browsing. The list is
    // for holding a target to the domains it actually needs.
    expect(allowed("https://example.com/page")).toBe(true);
    expect(allowed("http://news.example.co.uk")).toBe(true);
  });

  it("refuses cloud metadata even with no allowlist and even by IPv6", () => {
    // The address that hands out cloud credentials to anything that asks. This
    // is the one that matters when someone has left the allowlist empty.
    expect(allowed("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(allowed("http://metadata.google.internal/computeMetadata/v1/")).toBe(false);
    expect(allowed("http://[::ffff:169.254.169.254]/")).toBe(false);
    expect(reason("http://169.254.169.254/")).toContain("link-local");
  });

  it("refuses private and loopback ranges", () => {
    for (const url of [
      "http://127.0.0.1:8080/",
      "http://localhost:3000/",
      "http://10.1.2.3/",
      "http://192.168.1.1/",
      "http://172.16.0.9/",
      "http://[::1]:9000/",
      "http://[fd00::1]/",
      "http://router.local/",
      "http://build-server/",
    ]) {
      expect(allowed(url), url).toBe(false);
    }
  });

  it("does not mistake a public address inside a private-looking range", () => {
    // 172.32 is public; only 172.16 through 172.31 is not. An over-broad check
    // here would refuse real sites and look like a bug in the target.
    expect(allowed("http://172.32.0.1/")).toBe(true);
    expect(allowed("http://11.0.0.1/")).toBe(true);
  });

  it("reaches an internal host only when the target opts in", () => {
    const policy = { allowPrivateNetwork: true, allowedHosts: ["10.0.0.5"] };
    expect(allowed("http://10.0.0.5:8080/health", policy)).toBe(true);
    // The opt-in widens the address space, it does not discard the allowlist.
    expect(allowed("http://10.0.0.6/", policy)).toBe(false);
  });

  it("covers subdomains of an allowed host but not lookalikes", () => {
    const policy = { allowedHosts: ["example.com"] };
    expect(allowed("https://example.com/a", policy)).toBe(true);
    expect(allowed("https://www.example.com/a", policy)).toBe(true);
    expect(allowed("https://notexample.com/a", policy)).toBe(false);
    expect(allowed("https://example.com.evil.test/a", policy)).toBe(false);
  });

  it("refuses schemes that are not the web", () => {
    // file: reads the provider's own disk and data: carries its payload with
    // it, so neither is somewhere a browsing target gets sent.
    expect(allowed("file:///etc/passwd")).toBe(false);
    expect(allowed("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(allowed("javascript:alert(1)")).toBe(false);
  });

  it("treats the browser's own blank page as somewhere it may be", () => {
    // Used to park a tab, including when a navigation is refused.
    expect(allowed("about:blank")).toBe(true);
  });

  it("names the host and the list when it refuses", () => {
    // A refusal that does not say what was expected leaves someone guessing at
    // their own configuration.
    const text = reason("https://other.test/", { allowedHosts: ["example.com", "docs.test"] });
    expect(text).toContain("other.test");
    expect(text).toContain("example.com, docs.test");
  });
});

describe("normalizeHost", () => {
  it("accepts the shapes people actually type", () => {
    expect(normalizeHost("https://Example.com/path")).toBe("example.com");
    expect(normalizeHost("  example.com:8443 ")).toBe("example.com");
    expect(normalizeHost(".example.com")).toBe("example.com");
    expect(normalizeHost("")).toBe("");
  });
});

describe("isPrivateHost", () => {
  it("treats an unparseable or empty host as private rather than public", () => {
    // The safe direction: something that cannot be understood is not proven
    // safe to reach.
    expect(isPrivateHost("")).toBe(true);
  });
});
