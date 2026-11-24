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
/**
 * What `GET /gw/v1/connectors/capabilities` answers (Eragon_s
 * `services/gateway-connectors.ts` `capabilities`): the key's granted apps,
 * whether the workspace has Connections on, and the reviewed tool ids the
 * key may use. The bridge keeps the apps and tool ids.
 */
export type Capabilities = {
    version: 1;
    apps: string[];
    tools: string[];
};
/**
 * - `available`: the Gateway serves Connections to this key: the workspace
 *   has them on and the key may use at least one reviewed tool.
 * - `none`: it answered that it does not: 404 from a Gateway without the
 *   endpoint or with Connections off, a refused key, a workspace that is off
 *   or a key with no app, or an answer this bridge does not understand.
 * - `unreachable`: no answer yet (network, timeout, 429, 5xx, or no key yet).
 */
export type ProbeOutcome = {
    kind: "available";
    capabilities: Capabilities;
} | {
    kind: "none";
} | {
    kind: "unreachable";
};
/** The capabilities answer when it offers Connections, or undefined (off, empty, or not understood). */
export declare function parseCapabilities(body: unknown): Capabilities | undefined;
export declare function probeCapabilities(config: {
    gatewayUrl: string;
    token: string;
    fetchImpl?: typeof fetch;
    /** A recheck inside a tool call passes what is left of that call's deadline. */
    timeoutMs?: number;
}): Promise<ProbeOutcome>;
export declare function defaultCapabilityCacheFile(): string;
/**
 * The last capabilities answer per key and Gateway origin, so a slow start
 * still lists Connections the key had yesterday. An entry is named by the
 * key's SHA-256 and the origin: the file never holds the key. A key that a
 * key command prints is also indexed by the command's SHA-256, so a restart
 * finds its entry before the command has finished (ERA-5056 review: a key
 * command slower than the first list otherwise never lists Connections). The
 * file never holds the command either. Any problem reading or writing it is
 * treated as an empty cache.
 */
export declare class CapabilityCache {
    private readonly file;
    private readonly now;
    constructor(file: string, now?: () => number);
    static entryName(token: string, gatewayUrl: string): string;
    static keyHash(token: string): string;
    private static entryNameOfHash;
    private static sourceName;
    private fresh;
    read(token: string, gatewayUrl: string): Capabilities | undefined;
    /** The entry the key source last read, before its key is known; the caller checks the key once it is. */
    readBySource(source: string, gatewayUrl: string): {
        keyHash: string;
        capabilities: Capabilities;
    } | undefined;
    private readHash;
    write(token: string, gatewayUrl: string, capabilities: Capabilities, source?: string): void;
    remove(token: string, gatewayUrl: string): void;
    private load;
    private save;
}
//# sourceMappingURL=capabilities.d.ts.map