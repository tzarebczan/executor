import { describe, expect, it } from "@effect/vitest";

import {
  BROWSER_PROTOCOL_VERSION,
  BROWSER_TOOL_DEFINITIONS,
  BROWSER_TOOL_NAMES,
  browserToolCatalogName,
  browserToolNameFromCatalog,
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
    }
  });
});
