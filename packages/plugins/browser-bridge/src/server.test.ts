import { describe, expect, it } from "@effect/vitest";

import { BROWSER_TOOL_CATALOG, validateInnerCall } from "./server";

const catalogByName = new Map(BROWSER_TOOL_CATALOG.map((entry) => [String(entry.name), entry]));

describe("browser bridge tool catalog", () => {
  it("publishes an input schema for every tool", () => {
    for (const entry of BROWSER_TOOL_CATALOG) {
      expect(entry.inputSchema, String(entry.name)).toBeDefined();
    }
  });

  it.each(["call", "navigate", "click", "type", "tabs_open", "screenshot", "evaluate"])(
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
      /invalid format|HTTP/,
    );
  });

  it("rejects unexpected args on ping", () => {
    expect(() => validateInnerCall("ping", { evil: true })).toThrow(/Unexpected arg/);
  });

  it("rejects unknown tools", () => {
    expect(() => validateInnerCall("eval", {})).toThrow(/Unknown browser tool/);
  });

  it("requires click target", () => {
    expect(() => validateInnerCall("click", {})).toThrow(/selector|nodeIndex|x and y/);
  });

  it("accepts the expanded interaction surface", () => {
    expect(validateInnerCall("press", { key: "Enter" }).tool).toBe("press");
    expect(validateInnerCall("wait", { selector: "#ready", timeoutMs: 5000 }).tool).toBe("wait");
    expect(validateInnerCall("viewport.set", { width: 1280, height: 720 }).tool).toBe(
      "viewport.set",
    );
  });

  it("rejects unknown arguments on every path", () => {
    expect(() => validateInnerCall("snapshot", { secret: true })).toThrow(/Unexpected argument/);
  });
});
