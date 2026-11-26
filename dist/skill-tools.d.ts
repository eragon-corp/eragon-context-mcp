import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
export declare const SKILL_PROBE_TIMEOUT_MS = 5000;
export declare const SKILL_CALL_TIMEOUT_MS = 45000;
export declare const SKILL_TOOLS: Tool[];
export declare const SKILL_TOOL_NAMES: Set<string>;
type SkillConfig = {
    gatewayUrl: string;
    token: string;
    fetchImpl?: typeof fetch;
};
type ProbeOutcome = {
    kind: "available" | "absent";
} | {
    kind: "unknown";
    retry: boolean;
    retryAfterSeconds?: number;
};
export declare function probeSkills(config: SkillConfig, timeoutMs?: number): Promise<ProbeOutcome>;
export declare function createSkillSession(onToolsChanged: () => void): {
    list(config: SkillConfig, timeoutMs?: number): Promise<Tool[]>;
    call(name: string, args: Record<string, unknown>, config: SkillConfig, deadline?: number): Promise<CallToolResult>;
    close(): void;
};
export {};
//# sourceMappingURL=skill-tools.d.ts.map