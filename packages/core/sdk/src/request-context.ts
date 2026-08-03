import { Context } from "effect";

/** Non-secret MCP client identity scoped to the current tool execution. */
export type ToolCallerInfo = {
  readonly name: string;
  readonly version?: string;
};

export const toolCallerRef = Context.Reference<ToolCallerInfo | null>(
  "executor/ToolCallerInfo",
  { defaultValue: () => null },
);
