import { randomUUID } from "node:crypto";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { callMemoryTool, MEMORY_TOOLS, type MemoryToolConfig } from "./memory-tools.js";

export function fallbackIdempotencyKey(
  sessionId: string,
  requestId: string | number,
): string {
  return `mcp:${sessionId}:${String(requestId)}`;
}

export async function runMemoryMcp(config: MemoryToolConfig): Promise<void> {
  const sessionId = randomUUID();
  const server = new Server(
    { name: "eragon-context", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: MEMORY_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
    callMemoryTool(
      request.params.name,
      request.params.arguments ?? {},
      config,
      fallbackIdempotencyKey(sessionId, extra.requestId),
    ),
  );
  await server.connect(new StdioServerTransport());
}
