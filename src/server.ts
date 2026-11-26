import { randomUUID } from "node:crypto";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { callMemoryTool, MEMORY_TOOLS, type MemoryToolConfig } from "./memory-tools.js";
import { createSkillSession, SKILL_TOOL_NAMES } from "./skill-tools.js";
import { VERSION } from "./version.js";

export function fallbackIdempotencyKey(
  sessionId: string,
  requestId: string | number,
): string {
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

export function createMemoryMcpServer(config: MemoryToolConfig): Server {
  const sessionId = randomUUID();
  const server = new Server(
    { name: "eragon-context", version: VERSION },
    { capabilities: { tools: { listChanged: true } }, instructions: MEMORY_INSTRUCTIONS },
  );
  const skills = createSkillSession(() => { server.sendToolListChanged().catch(() => undefined); });
  server.onclose = () => skills.close();
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: [...MEMORY_TOOLS, ...await skills.list(config)] };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args = {} } = request.params;
    if (SKILL_TOOL_NAMES.has(name)) {
      return skills.call(name, args, config);
    }
    return callMemoryTool(name, args, config, fallbackIdempotencyKey(sessionId, extra.requestId));
  });
  return server;
}

export async function runMemoryMcp(config: MemoryToolConfig): Promise<void> {
  await createMemoryMcpServer(config).connect(new StdioServerTransport());
}
