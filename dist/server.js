import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CAPABILITY_PROBE_WAIT_MS, CAPABILITY_RETRY_MS, CapabilityCache, defaultCapabilityCacheFile, probeCapabilities, } from "./capabilities.js";
import { GATEWAY_FETCH_TIMEOUT_MS } from "./client.js";
import { callConnectorTool, CONNECTOR_TOOL_NAMES, CONNECTOR_TOOLS } from "./connector-tools.js";
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
/** Appended once to a Memory result when Connections arrived after the session listed its tools. */
export const CONNECTIONS_LATE_NOTE = "Eragon Connections were unavailable when this session started. Restart the session to load them.";
export function staticKey(token) {
    const result = { ok: true, token };
    return async () => result;
}
/** How many times a probe that could not reach Eragon is tried again (once a minute). */
export const CAPABILITY_RETRIES = 10;
/** How many held Memory save ids a session remembers; an older one is still found after the connector route's not_found. */
export const HELD_SAVES_MAX = 256;
/** The promise's value, or `fallback` once `ms` have passed. */
async function within(promise, ms, fallback) {
    if (ms <= 0)
        return fallback;
    let timer;
    try {
        return await Promise.race([promise, new Promise((resolve) => (timer = setTimeout(() => resolve(fallback), ms)))]);
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * Whether this key gets Connections, as the session should list them.
 * The probe starts with the bridge; the first tools/list waits for it at most
 * `probeWaitMs` from then, and a slower answer is still taken when it comes.
 * Only a probe that had a key and could not reach Eragon is retried in the
 * background: a key command that failed runs again only when a tool call
 * asks for the key, so a locked keychain is not prompted every minute.
 *
 * Every change to what it would list (the cache read once the key is known,
 * each answer) is reported through `onChange`; the server compares it with
 * what the client last listed, so no change is lost between snapshots.
 */
class ConnectorAvailability {
    options;
    outcome;
    cached;
    token;
    learned = new Map();
    deadline;
    firstSettled;
    retry;
    retries = 0;
    started = 0;
    applied = 0;
    probing = false;
    /** Whose key the cached entry is (SHA-256): it may have been read by key source before the key was known. */
    cachedFor;
    rechecking;
    constructor(options) {
        this.options = options;
        this.deadline = options.now() + options.probeWaitMs;
        if (options.keySource !== undefined) {
            const hit = options.cache?.readBySource(options.keySource, options.gatewayUrl);
            if (hit !== undefined) {
                this.cached = hit.capabilities;
                this.cachedFor = hit.keyHash;
            }
        }
        this.firstSettled = this.probe().then(() => undefined);
    }
    /** Resolves when the first probe settles or the start-up wait runs out, whichever is first. */
    async waitForFirstAnswer() {
        const remaining = this.deadline - this.options.now();
        if (remaining <= 0)
            return;
        let timer;
        await Promise.race([
            this.firstSettled,
            new Promise((resolve) => {
                timer = setTimeout(resolve, remaining);
            }),
        ]);
        clearTimeout(timer);
    }
    /** The capabilities the session should list: a fresh answer, else (with no answer yet) a cached one. */
    capabilities() {
        if (this.outcome?.kind === "available")
            return this.outcome.capabilities;
        if (this.outcome?.kind === "none")
            return undefined;
        return this.cached;
    }
    /** Whether Eragon itself (not the cache) has said this key has Connections. */
    get answeredAvailable() {
        return this.outcome?.kind === "available";
    }
    /** A tool's effect and app, from a connector_tools answer (capabilities name tools, not their effects). */
    known(toolId) {
        return this.learned.get(toolId);
    }
    learn(tools) {
        for (const tool of tools)
            this.learned.set(tool.id, tool);
    }
    /** A tool call read the key: probe now if no probe ever had one (the key command failed at start). */
    keyRead() {
        if (this.token === undefined && !this.probing)
            void this.probe();
    }
    /**
     * A connector call answered 404. Ask Eragon again rather than guess what
     * the 404 meant: true when it confirms this key has no Connections now
     * (the cache entry is forgotten and the client told), false otherwise.
     */
    async recheck(remainingMs) {
        // Refusals at the same moment share one probe; each waits only as long as its own call may.
        this.rechecking ??= this.probe(remainingMs)
            .then((outcome) => outcome.kind === "none")
            .finally(() => {
            this.rechecking = undefined;
        });
        return within(this.rechecking, remainingMs, false);
    }
    stop() {
        clearTimeout(this.retry);
    }
    async probe(timeoutMs) {
        const sequence = ++this.started;
        this.probing = true;
        try {
            const key = await this.options.key();
            if (!key.ok) {
                this.apply(sequence, { kind: "unreachable" }, undefined);
                return { kind: "unreachable" };
            }
            this.token = key.token;
            this.adoptKey(key.token);
            const outcome = await probeCapabilities({
                gatewayUrl: this.options.gatewayUrl,
                token: key.token,
                ...(timeoutMs === undefined ? {} : { timeoutMs }),
                ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
            });
            this.apply(sequence, outcome, key.token);
            return outcome;
        }
        finally {
            if (sequence === this.started)
                this.probing = false;
        }
    }
    /** The key is known: the cached entry stands only if it is this key's (the key command may print another key now). */
    adoptKey(token) {
        const hash = CapabilityCache.keyHash(token);
        if (this.cachedFor === hash)
            return;
        this.cachedFor = hash;
        this.cached = this.options.cache?.read(token, this.options.gatewayUrl);
        this.options.onChange(this.capabilities() !== undefined);
    }
    apply(sequence, outcome, token) {
        // An answer older than one already taken (the slow first probe after a recheck) changes nothing.
        if (sequence < this.applied)
            return;
        if (outcome.kind !== "unreachable") {
            this.applied = sequence;
            this.outcome = outcome;
            clearTimeout(this.retry);
            if (token !== undefined && outcome.kind === "available") {
                this.options.cache?.write(token, this.options.gatewayUrl, outcome.capabilities, this.options.keySource);
            }
            if (token !== undefined && outcome.kind === "none")
                this.options.cache?.remove(token, this.options.gatewayUrl);
        }
        else {
            if (this.outcome === undefined)
                this.outcome = outcome;
            if (token !== undefined && this.outcome.kind === "unreachable" && this.retries < CAPABILITY_RETRIES) {
                this.retries += 1;
                clearTimeout(this.retry);
                this.retry = setTimeout(() => void this.probe(), this.options.retryMs);
                this.retry.unref?.();
            }
        }
        this.options.onChange(this.capabilities() !== undefined);
    }
}
/**
 * The bridge's MCP server. Against a Gateway without Connections (no
 * capabilities endpoint, the flag or workspace off, a key without the grant)
 * it lists and answers exactly as the Memory-only bridge did.
 */
export function createBridgeServer(options) {
    const sessionId = randomUUID();
    const connectorsOn = options.connectors !== false && options.connectors !== undefined;
    const server = new Server({ name: "eragon-context", version: VERSION }, {
        // listChanged tells a client that refreshes its tools that Connections may arrive late.
        capabilities: { tools: connectorsOn ? { listChanged: true } : {} },
        instructions: MEMORY_INSTRUCTIONS,
    });
    let listed;
    /** What the client was last told, by listing or by a list_changed since. */
    let shown;
    /** Memory saves Eragon held for confirmation in this session: connector_call_status reads them from the Memory save route. */
    const heldSaves = new Set();
    const holdSave = (id) => {
        heldSaves.delete(id);
        heldSaves.add(id);
        // The oldest goes first; connector_call_status still finds it after the connector route's not_found.
        for (const oldest of heldSaves) {
            if (heldSaves.size <= HELD_SAVES_MAX)
                break;
            heldSaves.delete(oldest);
        }
    };
    let noteGiven = false;
    let availability;
    if (options.connectors !== false && options.connectors !== undefined) {
        const settings = options.connectors;
        const cacheFile = settings.cacheFile === undefined ? defaultCapabilityCacheFile() : settings.cacheFile;
        const now = settings.now ?? Date.now;
        availability = new ConnectorAvailability({
            gatewayUrl: options.gatewayUrl,
            key: options.key,
            keySource: options.keySource,
            fetchImpl: options.fetchImpl,
            cache: cacheFile === null ? undefined : new CapabilityCache(cacheFile, now),
            probeWaitMs: settings.probeWaitMs ?? CAPABILITY_PROBE_WAIT_MS,
            retryMs: settings.retryMs ?? CAPABILITY_RETRY_MS,
            now,
            onChange: (connectors) => {
                // Only a client that has listed needs telling; one that has not will list the new set.
                if (shown === undefined || shown === connectors)
                    return;
                shown = connectors;
                settings.onToolsChanged?.();
                server.sendToolListChanged().catch(() => undefined);
            },
        });
        const stop = availability;
        server.onclose = () => stop.stop();
    }
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        let tools = MEMORY_TOOLS;
        if (availability !== undefined) {
            await availability.waitForFirstAnswer();
            if (availability.capabilities() !== undefined)
                tools = [...MEMORY_TOOLS, ...CONNECTOR_TOOLS];
        }
        listed = { connectors: tools !== MEMORY_TOOLS };
        shown = listed.connectors;
        return { tools };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const name = request.params.name;
        const args = request.params.arguments ?? {};
        if (availability !== undefined && CONNECTOR_TOOL_NAMES.has(name)) {
            // One deadline for the whole call: the key, every request, and a recheck (ERA-5056 review).
            const deadline = Date.now() + GATEWAY_FETCH_TIMEOUT_MS;
            const key = await within(options.key(), GATEWAY_FETCH_TIMEOUT_MS, undefined);
            if (key === undefined) {
                return {
                    isError: true,
                    content: [{ type: "text", text: `The key command did not print a key within ${GATEWAY_FETCH_TIMEOUT_MS / 1000} s, so nothing was sent. Try again.` }],
                };
            }
            if (!key.ok)
                return { isError: true, content: [{ type: "text", text: key.error }] };
            availability.keyRead();
            const known = availability;
            return callConnectorTool(name, args, {
                gatewayUrl: options.gatewayUrl,
                token: key.token,
                ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
                known: (toolId) => known.known(toolId),
                learn: (tools) => known.learn(tools),
                isMemorySave: (id) => heldSaves.has(id),
                confirmUnavailable: (remainingMs) => known.recheck(remainingMs),
                deadline,
                budgetMs: GATEWAY_FETCH_TIMEOUT_MS,
            });
        }
        const key = await options.key();
        if (key.ok)
            availability?.keyRead();
        if (!key.ok)
            return { isError: true, content: [{ type: "text", text: key.error }] };
        const config = {
            gatewayUrl: options.gatewayUrl,
            token: key.token,
            ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
            onHeld: holdSave,
        };
        const result = await callMemoryTool(name, args, config, fallbackIdempotencyKey(sessionId, extra.requestId));
        // The session listed Memory alone and Connections have answered since: say a restart loads them, once.
        if (availability !== undefined &&
            !noteGiven &&
            listed?.connectors === false &&
            availability.answeredAvailable) {
            noteGiven = true;
            return { ...result, content: [...result.content, { type: "text", text: CONNECTIONS_LATE_NOTE }] };
        }
        return result;
    });
    return server;
}
/** The Memory-only bridge: today's three tools and nothing else. */
export function createMemoryMcpServer(config) {
    return createBridgeServer({
        gatewayUrl: config.gatewayUrl,
        key: staticKey(config.token),
        ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
        connectors: false,
    });
}
export async function runBridge(options) {
    await createBridgeServer({ ...options, connectors: {} }).connect(new StdioServerTransport());
}
export async function runMemoryMcp(config) {
    await createMemoryMcpServer(config).connect(new StdioServerTransport());
}
//# sourceMappingURL=server.js.map