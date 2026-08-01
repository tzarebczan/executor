import { describe, expect, it } from "@effect/vitest";

import { BROWSER_TOOL_CATALOG, validateInnerCall } from "./server";

const catalogByName = new Map(BROWSER_TOOL_CATALOG.map((entry) => [String(entry.name), entry]));

describe("browser bridge tool catalog", () => {
  it("publishes an input schema for every tool", () => {
    for (const entry of BROWSER_TOOL_CATALOG) {
      expect(entry.inputSchema, String(entry.name)).toBeDefined();
    }
  });

  it.each(["call", "navigate", "click", "type", "tabs_open", "screenshot"])(
    "requires approval for %s",
    (name) => {
      expect(catalogByName.get(name)?.annotations?.requiresApproval).toBe(true);
    },
  );

  it.each(["status", "snapshot", "tabs_list", "ping"])(
    "does not mark read-only tool %s as mutating",
    (name) => {
      expect(catalogByName.get(name)?.annotations?.requiresApproval).not.toBe(true);
    },
  );
});

describe("validateInnerCall", () => {
  it("accepts navigate with https URL", () => {
    const out = validateInnerCall("navigate", { url: "https://example.com/x" });
    expect(out.tool).toBe("navigate");
    expect(out.args.url).toBe("https://example.com/x");
  });

  it("rejects javascript: navigate URLs", () => {
    expect(() => validateInnerCall("navigate", { url: "javascript:alert(1)" })).toThrow(
      /http or https/,
    );
  });

  it("rejects unexpected args on ping", () => {
    expect(() => validateInnerCall("ping", { evil: true })).toThrow(/Unexpected arg/);
  });

  it("rejects unknown tools", () => {
    expect(() => validateInnerCall("eval", {})).toThrow(/disallowed/);
  });

  it("requires click target", () => {
    expect(() => validateInnerCall("click", {})).toThrow(/selector|nodeIndex|x\+y/);
  });
});
