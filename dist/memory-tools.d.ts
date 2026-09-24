import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
export declare const MEMORY_TOOLS: Tool[];
export type MemoryToolConfig = {
    gatewayUrl: string;
    token: string;
    fetchImpl?: typeof fetch;
};
export declare function callMemoryTool(name: string, args: Record<string, unknown>, config: MemoryToolConfig, fallbackIdempotencyKey?: string): Promise<CallToolResult>;
//# sourceMappingURL=memory-tools.d.ts.map