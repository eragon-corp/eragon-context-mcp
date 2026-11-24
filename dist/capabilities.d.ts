/**
 * How long the first tools/list waits for the capabilities probe (ERA-5056).
 * Codex 0.170 lists an MCP server's tools once, inside its start-up timeout
 * (10 s in older releases), and refreshes them only behind
 * `mcp_tool_list_changed`, which is off by default: the first list is the one
 * the session keeps. Five seconds is long enough for a healthy Gateway and
 * leaves the rest of that window.
 */
export declare const CAPABILITY_PROBE_WAIT_MS = 5000;
/** A probe that could not reach Eragon is tried again this often, until it gets an answer. */
export declare const CAPABILITY_RETRY_MS = 60000;
/** A cached answer stands in for a slow probe for this long. */
export declare const CAPABILITY_CACHE_TTL_MS: number;
/** The only capabilities version this bridge understands; any other is treated as no Connections. */
export declare const CAPABILITIES_VERSION = 1;
export declare const CAPABILITIES_PATH = "/v1/connectors/capabilities";
export type ConnectorEffect = "read" | "write";
export type ConnectorToolSummary = {
    id: string;
    app: string;
    effect: ConnectorEffect;
};
export type Capabilities = {
    version: 1;
    apps: string[];
    tools: ConnectorToolSummary[];
};
/**
 * - `available`: the Gateway serves Connections to this key.
 * - `none`: it answered that it does not (404 from a server without the
 *   endpoint, a workspace or key without the grant, a refused key, or an
 *   answer this bridge does not understand). Definitive until a restart.
 * - `unreachable`: no answer (network, timeout, 5xx, or no key yet).
 */
export type ProbeOutcome = {
    kind: "available";
    capabilities: Capabilities;
} | {
    kind: "none";
} | {
    kind: "unreachable";
};
/** The capabilities answer, or undefined when it is not one this bridge understands. */
export declare function parseCapabilities(body: unknown): Capabilities | undefined;
export declare function probeCapabilities(config: {
    gatewayUrl: string;
    token: string;
    fetchImpl?: typeof fetch;
}): Promise<ProbeOutcome>;
export declare function defaultCapabilityCacheFile(): string;
/**
 * The last capabilities answer per key and Gateway origin, so a slow start
 * still lists Connections the key had yesterday. An entry is named by the
 * key's SHA-256 and the origin: the file never holds the key. Any problem
 * reading or writing it is treated as an empty cache.
 */
export declare class CapabilityCache {
    private readonly file;
    private readonly now;
    constructor(file: string, now?: () => number);
    static entryName(token: string, gatewayUrl: string): string;
    read(token: string, gatewayUrl: string): Capabilities | undefined;
    write(token: string, gatewayUrl: string, capabilities: Capabilities): void;
    remove(token: string, gatewayUrl: string): void;
    private load;
    private save;
}
//# sourceMappingURL=capabilities.d.ts.map