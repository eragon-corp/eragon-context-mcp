import { randomUUID } from "node:crypto";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";

import {
  CAPABILITY_PROBE_WAIT_MS,
  CAPABILITY_RETRY_MS,
  CapabilityCache,
  defaultCapabilityCacheFile,
  probeCapabilities,
  type Capabilities,
  type ConnectorEffect,
  type ProbeOutcome,
} from "./capabilities.js";
import { callConnectorTool, CONNECTOR_TOOL_NAMES, CONNECTOR_TOOLS } from "./connector-tools.js";
import { callMemoryTool, MEMORY_TOOLS, type MemoryToolConfig } from "./memory-tools.js";
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

/** Appended once to a Memory result when Connections arrived after the session listed its tools. */
export const CONNECTIONS_LATE_NOTE =
  "Eragon Connections were unavailable when this session started. Restart the session to load them.";

export type KeyResult = { ok: true; token: string } | { ok: false; error: string };
/** Where the bridge gets its key: at once from the environment, or by running the key command. */
export type KeySource = () => Promise<KeyResult>;

export type BridgeOptions = {
  gatewayUrl: string;
  key: KeySource;
  fetchImpl?: typeof fetch;
  /** Off: exactly the Memory bridge, with no probe. */
  connectors?:
    | false
    | {
        /** null: no cache file. */
        cacheFile?: string | null;
        probeWaitMs?: number;
        retryMs?: number;
        now?: () => number;
        /** A late change to the tool list, for a test to observe. */
        onToolsChanged?: () => void;
      };
};

export function staticKey(token: string): KeySource {
  const result: KeyResult = { ok: true, token };
  return async () => result;
}

/** How many times a probe that could not reach Eragon is tried again (once a minute). */
export const CAPABILITY_RETRIES = 10;

/**
 * Whether this key gets Connections, as the session should list them.
 * The probe starts with the bridge; the first tools/list waits for it at most
 * `probeWaitMs` from then, and a slower answer is still taken when it comes.
 * Only a probe that had a key and could not reach Eragon is retried in the
 * background: a key command that failed runs again only when a tool call
 * asks for the key, so a locked keychain is not prompted every minute.
 */
class ConnectorAvailability {
  private outcome: ProbeOutcome | undefined;
  private cached: Capabilities | undefined;
  private token: string | undefined;
  private readonly effects = new Map<string, ConnectorEffect>();
  private readonly deadline: number;
  private readonly firstSettled: Promise<void>;
  private retry: NodeJS.Timeout | undefined;
  private retries = 0;
  private started = 0;
  private applied = 0;
  private probing = false;

  constructor(
    private readonly options: {
      gatewayUrl: string;
      key: KeySource;
      fetchImpl: typeof fetch | undefined;
      cache: CapabilityCache | undefined;
      probeWaitMs: number;
      retryMs: number;
      now: () => number;
      onChange: () => void;
    },
  ) {
    this.deadline = options.now() + options.probeWaitMs;
    this.firstSettled = this.probe().then(() => undefined);
  }

  /** Resolves when the first probe settles or the start-up wait runs out, whichever is first. */
  async waitForFirstAnswer(): Promise<void> {
    const remaining = this.deadline - this.options.now();
    if (remaining <= 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.firstSettled,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, remaining);
      }),
    ]);
    clearTimeout(timer);
  }

  /** The capabilities the session should list: a fresh answer, else (with no answer yet) a cached one. */
  capabilities(): Capabilities | undefined {
    if (this.outcome?.kind === "available") return this.outcome.capabilities;
    if (this.outcome?.kind === "none") return undefined;
    return this.cached;
  }

  /** Whether Eragon itself (not the cache) has said this key has Connections. */
  get answeredAvailable(): boolean {
    return this.outcome?.kind === "available";
  }

  effectOf(toolId: string): ConnectorEffect | undefined {
    const learned = this.effects.get(toolId);
    if (learned !== undefined) return learned;
    return this.capabilities()?.tools.find((tool) => tool.id === toolId)?.effect;
  }

  learn(tools: { id: string; effect: ConnectorEffect }[]): void {
    for (const tool of tools) this.effects.set(tool.id, tool.effect);
  }

  /** A tool call read the key: probe now if no probe ever had one (the key command failed at start). */
  keyRead(): void {
    if (this.token === undefined && !this.probing) void this.probe();
  }

  /**
   * A connector call answered 404. Ask Eragon again rather than guess what
   * the 404 meant: true when it confirms this key has no Connections now
   * (the cache entry is forgotten and the client told), false otherwise.
   */
  async recheck(): Promise<boolean> {
    return (await this.probe()).kind === "none";
  }

  stop(): void {
    clearTimeout(this.retry);
  }

  private async probe(): Promise<ProbeOutcome> {
    const sequence = ++this.started;
    this.probing = true;
    try {
      const key = await this.options.key();
      if (!key.ok) {
        this.apply(sequence, { kind: "unreachable" }, undefined);
        return { kind: "unreachable" };
      }
      this.token = key.token;
      if (this.cached === undefined) this.cached = this.options.cache?.read(key.token, this.options.gatewayUrl);
      const outcome = await probeCapabilities({
        gatewayUrl: this.options.gatewayUrl,
        token: key.token,
        ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
      });
      this.apply(sequence, outcome, key.token);
      return outcome;
    } finally {
      if (sequence === this.started) this.probing = false;
    }
  }

  private apply(sequence: number, outcome: ProbeOutcome, token: string | undefined): void {
    // An answer older than one already taken (the slow first probe after a recheck) changes nothing.
    if (sequence < this.applied) return;
    const before = toolNames(this.capabilities());
    if (outcome.kind !== "unreachable") {
      this.applied = sequence;
      this.outcome = outcome;
      clearTimeout(this.retry);
      if (token !== undefined && outcome.kind === "available") this.options.cache?.write(token, this.options.gatewayUrl, outcome.capabilities);
      if (token !== undefined && outcome.kind === "none") this.options.cache?.remove(token, this.options.gatewayUrl);
    } else {
      if (this.outcome === undefined) this.outcome = outcome;
      if (token !== undefined && this.outcome.kind === "unreachable" && this.retries < CAPABILITY_RETRIES) {
        this.retries += 1;
        clearTimeout(this.retry);
        this.retry = setTimeout(() => void this.probe(), this.options.retryMs);
        this.retry.unref?.();
      }
    }
    if (toolNames(this.capabilities()) !== before) this.options.onChange();
  }
}

function toolNames(capabilities: Capabilities | undefined): string {
  return capabilities === undefined ? "" : CONNECTOR_TOOLS.map((tool) => tool.name).join(",");
}

/**
 * The bridge's MCP server. Against a Gateway without Connections (no
 * capabilities endpoint, the flag or workspace off, a key without the grant)
 * it lists and answers exactly as the Memory-only bridge did.
 */
export function createBridgeServer(options: BridgeOptions): Server {
  const sessionId = randomUUID();
  const connectorsOn = options.connectors !== false && options.connectors !== undefined;
  const server = new Server(
    { name: "eragon-context", version: VERSION },
    {
      // listChanged tells a client that refreshes its tools that Connections may arrive late.
      capabilities: { tools: connectorsOn ? { listChanged: true } : {} },
      instructions: MEMORY_INSTRUCTIONS,
    },
  );

  let listed: { connectors: boolean } | undefined;
  let noteGiven = false;
  let availability: ConnectorAvailability | undefined;
  if (options.connectors !== false && options.connectors !== undefined) {
    const settings = options.connectors;
    const cacheFile = settings.cacheFile === undefined ? defaultCapabilityCacheFile() : settings.cacheFile;
    const now = settings.now ?? Date.now;
    availability = new ConnectorAvailability({
      gatewayUrl: options.gatewayUrl,
      key: options.key,
      fetchImpl: options.fetchImpl,
      cache: cacheFile === null ? undefined : new CapabilityCache(cacheFile, now),
      probeWaitMs: settings.probeWaitMs ?? CAPABILITY_PROBE_WAIT_MS,
      retryMs: settings.retryMs ?? CAPABILITY_RETRY_MS,
      now,
      onChange: () => {
        settings.onToolsChanged?.();
        // Only a client that has listed needs telling; one that has not will list the new set.
        if (listed !== undefined) server.sendToolListChanged().catch(() => undefined);
      },
    });
    const stop = availability;
    server.onclose = () => stop.stop();
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    let tools: Tool[] = MEMORY_TOOLS;
    if (availability !== undefined) {
      await availability.waitForFirstAnswer();
      if (availability.capabilities() !== undefined) tools = [...MEMORY_TOOLS, ...CONNECTOR_TOOLS];
    }
    listed = { connectors: tools !== MEMORY_TOOLS };
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    const key = await options.key();
    if (key.ok) availability?.keyRead();
    if (availability !== undefined && CONNECTOR_TOOL_NAMES.has(name)) {
      if (!key.ok) return { isError: true, content: [{ type: "text", text: key.error }] };
      const known = availability;
      return callConnectorTool(name, args, {
        gatewayUrl: options.gatewayUrl,
        token: key.token,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        effectOf: (toolId) => known.effectOf(toolId),
        learn: (tools) => known.learn(tools),
        confirmUnavailable: () => known.recheck(),
      });
    }
    if (!key.ok) return { isError: true, content: [{ type: "text", text: key.error }] };
    const config: MemoryToolConfig = {
      gatewayUrl: options.gatewayUrl,
      token: key.token,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    };
    const result = await callMemoryTool(name, args, config, fallbackIdempotencyKey(sessionId, extra.requestId));
    // The session listed Memory alone and Connections have answered since: say a restart loads them, once.
    if (
      availability !== undefined &&
      !noteGiven &&
      listed?.connectors === false &&
      availability.answeredAvailable
    ) {
      noteGiven = true;
      return { ...result, content: [...result.content, { type: "text", text: CONNECTIONS_LATE_NOTE }] };
    }
    return result;
  });
  return server;
}

/** The Memory-only bridge: today's three tools and nothing else. */
export function createMemoryMcpServer(config: MemoryToolConfig): Server {
  return createBridgeServer({
    gatewayUrl: config.gatewayUrl,
    key: staticKey(config.token),
    ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
    connectors: false,
  });
}

export async function runBridge(options: { gatewayUrl: string; key: KeySource }): Promise<void> {
  await createBridgeServer({ ...options, connectors: {} }).connect(new StdioServerTransport());
}

export async function runMemoryMcp(config: MemoryToolConfig): Promise<void> {
  await createMemoryMcpServer(config).connect(new StdioServerTransport());
}
