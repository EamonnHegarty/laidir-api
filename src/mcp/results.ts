import type { CallToolResult } from "@modelcontextprotocol/server";

/** A successful tool result: the data as JSON text (what Claude reads). */
export function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

/** A tool-level error Claude can see and recover from (not a protocol error). */
export function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

export const notFound = (what: string, id: string): CallToolResult =>
  toolError(`No ${what} with id ${id}. List them first to get a valid id.`);
