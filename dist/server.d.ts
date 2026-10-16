import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { type MemoryToolConfig } from "./memory-tools.js";
export declare function fallbackIdempotencyKey(sessionId: string, requestId: string | number): string;
/**
 * What the agent is told about Memory when it connects, so nobody has to put
 * the same thing in CLAUDE.md or AGENTS.md. The gateway adds a matching
 * protocol to every model call; this covers a client that does not keep the
 * gateway's system prompt.
 */
export declare const MEMORY_INSTRUCTIONS: string;
export declare function createMemoryMcpServer(config: MemoryToolConfig): Server;
export declare function runMemoryMcp(config: MemoryToolConfig): Promise<void>;
//# sourceMappingURL=server.d.ts.map