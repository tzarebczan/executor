import { describe, expect, it } from "@effect/vitest";

import {
  BROWSER_ERROR_CODES,
  BROWSER_PROTOCOL_VERSION,
  BROWSER_TOOL_DEFINITIONS,
  BROWSER_TOOL_NAMES,
  browserToolCatalogName,
  browserToolNameFromCatalog,
  isAdvancedBrowserTool,
} from "./protocol";

describe("browser protocol", () => {
  it("has a definition and reversible catalog name for every typed tool", () => {
    expect(BROWSER_PROTOCOL_VERSION).toBe(2);
    expect(BROWSER_TOOL_NAMES.length).toBeGreaterThan(20);
    for (const name of BROWSER_TOOL_NAMES) {
      expect(BROWSER_TOOL_DEFINITIONS[name].inputSchema, name).toBeDefined();
      expect(browserToolNameFromCatalog(browserToolCatalogName(name))).toBe(name);
    }
  });

  it("marks privileged CDP operations as advanced", () => {
    for (const name of [
      "dialog.handle",
      "console.list",
      "network.list",
      "evaluate",
      "pdf",
    ] as const) {
      expect(BROWSER_TOOL_DEFINITIONS[name].advanced, name).toBe(true);
      expect(isAdvancedBrowserTool(name), name).toBe(true);
    }
    expect(isAdvancedBrowserTool("snapshot")).toBe(false);
  });

  it("keeps failure codes distinct, so a caller can switch on them", () => {
    const codes = Object.values(BROWSER_ERROR_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  it("separates a refusal from a missing target", () => {
    // The distinction the extension bug erased: an out-of-scope tab used to be
    // reported as "no tab", which reads as retry-with-a-different-tab.
    expect(BROWSER_ERROR_CODES.hostNotAllowed).not.toBe(BROWSER_ERROR_CODES.noTab);
    expect(BROWSER_ERROR_CODES.outsideGroup).not.toBe(BROWSER_ERROR_CODES.noTab);
  });
});
