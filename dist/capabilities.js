import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { requestGateway } from "./client.js";
/**
 * How long the first tools/list waits for the capabilities probe (ERA-5056).
 * Codex 0.170 lists an MCP server's tools once, inside its start-up timeout
 * (10 s in older releases), and refreshes them only behind
 * `mcp_tool_list_changed`, which is off by default: the first list is the one
 * the session keeps. Five seconds is long enough for a healthy Gateway and
 * leaves the rest of that window.
 */
export const CAPABILITY_PROBE_WAIT_MS = 5_000;
/** A probe that could not reach Eragon is tried again this often, until it gets an answer. */
export const CAPABILITY_RETRY_MS = 60_000;
/** A cached answer stands in for a slow probe for this long. */
export const CAPABILITY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** The only capabilities version this bridge understands; any other is treated as no Connections. */
export const CAPABILITIES_VERSION = 1;
export const CAPABILITIES_PATH = "/v1/connectors/capabilities";
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value) => Array.isArray(value) ? value.filter((item) => typeof item === "string" && item !== "") : [];
/** The capabilities answer when it offers Connections, or undefined (off, empty, or not understood). */
export function parseCapabilities(body) {
    if (!isRecord(body) || body.version !== CAPABILITIES_VERSION)
        return undefined;
    // The server sends `workspace`; a cached entry has already been checked.
    if ("workspace" in body && body.workspace !== true)
        return undefined;
    const apps = strings(body.apps);
    const tools = strings(body.tools);
    if (apps.length === 0 || tools.length === 0)
        return undefined;
    return { version: CAPABILITIES_VERSION, apps, tools };
}
export async function probeCapabilities(config) {
    try {
        const response = await requestGateway({
            gatewayUrl: config.gatewayUrl,
            token: config.token,
            path: CAPABILITIES_PATH,
            method: "GET",
            ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
        });
        // A rate limit or an outage is no answer: ask again later, and let the cache stand in.
        if (response.status === 429 || response.status >= 500)
            return { kind: "unreachable" };
        if (response.status !== 200)
            return { kind: "none" };
        const capabilities = parseCapabilities(response.body);
        return capabilities === undefined ? { kind: "none" } : { kind: "available", capabilities };
    }
    catch {
        return { kind: "unreachable" };
    }
}
export function defaultCapabilityCacheFile() {
    return join(homedir(), ".eragon", "bridge-capabilities.json");
}
/**
 * The last capabilities answer per key and Gateway origin, so a slow start
 * still lists Connections the key had yesterday. An entry is named by the
 * key's SHA-256 and the origin: the file never holds the key. Any problem
 * reading or writing it is treated as an empty cache.
 */
export class CapabilityCache {
    file;
    now;
    constructor(file, now = Date.now) {
        this.file = file;
        this.now = now;
    }
    static entryName(token, gatewayUrl) {
        return `${createHash("sha256").update(token).digest("hex")}@${new URL(gatewayUrl).origin}`;
    }
    read(token, gatewayUrl) {
        const entry = this.load().entries[CapabilityCache.entryName(token, gatewayUrl)];
        if (entry === undefined || !(this.now() - entry.savedAt < CAPABILITY_CACHE_TTL_MS) || entry.savedAt > this.now()) {
            return undefined;
        }
        return parseCapabilities(entry.capabilities);
    }
    write(token, gatewayUrl, capabilities) {
        const cache = this.load();
        cache.entries[CapabilityCache.entryName(token, gatewayUrl)] = { savedAt: this.now(), capabilities };
        this.save(cache);
    }
    remove(token, gatewayUrl) {
        const cache = this.load();
        const name = CapabilityCache.entryName(token, gatewayUrl);
        if (!(name in cache.entries))
            return;
        delete cache.entries[name];
        this.save(cache);
    }
    load() {
        try {
            const parsed = JSON.parse(readFileSync(this.file, "utf8"));
            if (isRecord(parsed) && parsed.version === 1 && isRecord(parsed.entries)) {
                const entries = {};
                for (const [name, entry] of Object.entries(parsed.entries)) {
                    if (isRecord(entry) && typeof entry.savedAt === "number" && isRecord(entry.capabilities)) {
                        entries[name] = { savedAt: entry.savedAt, capabilities: entry.capabilities };
                    }
                }
                return { version: 1, entries };
            }
        }
        catch {
            // Missing or unreadable: an empty cache.
        }
        return { version: 1, entries: {} };
    }
    save(cache) {
        const now = this.now();
        for (const [name, entry] of Object.entries(cache.entries)) {
            if (!(now - entry.savedAt < CAPABILITY_CACHE_TTL_MS))
                delete cache.entries[name];
        }
        try {
            mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
            const temporary = `${this.file}.${process.pid}.tmp`;
            writeFileSync(temporary, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
            chmodSync(temporary, 0o600);
            renameSync(temporary, this.file);
        }
        catch {
            // A cache that cannot be written only costs the next slow start its Connections.
        }
    }
}
//# sourceMappingURL=capabilities.js.map