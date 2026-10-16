import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { callMemoryTool, MEMORY_TOOLS } from "./memory-tools.js";
import { VERSION } from "./version.js";
export function fallbackIdempotencyKey(sessionId, requestId) {
    return `mcp:${sessionId}:${String(requestId)}`;
}
/**
 * What the agent is told about Memory when it connects, so nobody has to put
 * the same thing in CLAUDE.md or AGENTS.md. The gateway adds a matching
 * protocol to every model call; this covers a client that does not keep the
 * gateway's system prompt.
 */
export const MEMORY_INSTRUCTIONS = [
    "Eragon Memory is the long-term memory this user shares between Eragon and their coding agents.",
    "Call memory_search when the task depends on the user's preferences, people, past decisions, or how their systems work, and what you already have does not settle it.",
    "Call memory_save without being asked when the user states a lasting fact, preference, procedure, or contact, or corrects one. To correct one of the user's own memories, pass its id from memory_search or from the Memory context as memory_id; either is the memory's real id, not a guess.",
    "A save may combine what the user said with what Memory already holds; never add details from neither, and never save secrets or the current task's temporary state. If memory_save says this key cannot write Eragon Memory, stop calling it.",
    "Call memory_share only when the user asks to share memories with named colleagues, their team, or the whole workspace. Nothing is shared until the user approves it in their Eragon Inbox, so tell them it is waiting there.",
].join("\n");
export function createMemoryMcpServer(config) {
    const sessionId = randomUUID();
    const server = new Server({ name: "eragon-context", version: VERSION }, { capabilities: { tools: {} }, instructions: MEMORY_INSTRUCTIONS });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: MEMORY_TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => callMemoryTool(request.params.name, request.params.arguments ?? {}, config, fallbackIdempotencyKey(sessionId, extra.requestId)));
    return server;
}
export async function runMemoryMcp(config) {
    await createMemoryMcpServer(config).connect(new StdioServerTransport());
}
//# sourceMappingURL=server.js.map