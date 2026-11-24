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
/** Appended once to a Memory result when Connections arrived after the session listed its tools. */
export declare const CONNECTIONS_LATE_NOTE = "Eragon Connections were unavailable when this session started. Restart the session to load them.";
export type KeyResult = {
    ok: true;
    token: string;
} | {
    ok: false;
    error: string;
};
/** Where the bridge gets its key: at once from the environment, or by running the key command. */
export type KeySource = () => Promise<KeyResult>;
export type BridgeOptions = {
    gatewayUrl: string;
    key: KeySource;
    /**
     * What the key comes from when it is not given outright (the key command),
     * so a restart can list yesterday's Connections before the command has
     * printed the key. Only its SHA-256 is kept.
     */
    keySource?: string;
    fetchImpl?: typeof fetch;
    /** Off: exactly the Memory bridge, with no probe. */
    connectors?: false | {
        /** null: no cache file. */
        cacheFile?: string | null;
        probeWaitMs?: number;
        retryMs?: number;
        now?: () => number;
        /** A late change to the tool list, for a test to observe. */
        onToolsChanged?: () => void;
    };
};
export declare function staticKey(token: string): KeySource;
/** How many times a probe that could not reach Eragon is tried again (once a minute). */
export declare const CAPABILITY_RETRIES = 10;
/** How many held Memory save ids a session remembers; an older one is still found after the connector route's not_found. */
export declare const HELD_SAVES_MAX = 256;
/**
 * The bridge's MCP server. Against a Gateway without Connections (no
 * capabilities endpoint, the flag or workspace off, a key without the grant)
 * it lists and answers exactly as the Memory-only bridge did.
 */
export declare function createBridgeServer(options: BridgeOptions): Server;
/** The Memory-only bridge: today's three tools and nothing else. */
export declare function createMemoryMcpServer(config: MemoryToolConfig): Server;
export declare function runBridge(options: {
    gatewayUrl: string;
    key: KeySource;
    keySource?: string;
}): Promise<void>;
export declare function runMemoryMcp(config: MemoryToolConfig): Promise<void>;
//# sourceMappingURL=server.d.ts.map