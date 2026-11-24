import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { GATEWAY_FETCH_TIMEOUT_MS, requestGateway } from "./client.js";

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

export type ConnectorEffect = "read" | "write";
/**
 * What `GET /gw/v1/connectors/capabilities` answers (Eragon_s
 * `services/gateway-connectors.ts` `capabilities`): the key's granted apps,
 * whether the workspace has Connections on, and the reviewed tool ids the
 * key may use. The bridge keeps the apps and tool ids.
 */
export type Capabilities = { version: 1; apps: string[]; tools: string[] };

/**
 * - `available`: the Gateway serves Connections to this key: the workspace
 *   has them on and the key may use at least one reviewed tool.
 * - `none`: it answered that it does not: 404 from a Gateway without the
 *   endpoint or with Connections off, a refused key, a workspace that is off
 *   or a key with no app, or an answer this bridge does not understand.
 * - `unreachable`: no answer yet (network, timeout, 429, 5xx, or no key yet).
 */
export type ProbeOutcome =
  | { kind: "available"; capabilities: Capabilities }
  | { kind: "none" }
  | { kind: "unreachable" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item !== "") : [];

/** The capabilities answer when it offers Connections, or undefined (off, empty, or not understood). */
export function parseCapabilities(body: unknown): Capabilities | undefined {
  if (!isRecord(body) || body.version !== CAPABILITIES_VERSION) return undefined;
  // The server sends `workspace`; a cached entry has already been checked.
  if ("workspace" in body && body.workspace !== true) return undefined;
  const apps = strings(body.apps);
  const tools = strings(body.tools);
  if (apps.length === 0 || tools.length === 0) return undefined;
  return { version: CAPABILITIES_VERSION, apps, tools };
}

export async function probeCapabilities(config: {
  gatewayUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  /** A recheck inside a tool call passes what is left of that call's deadline. */
  timeoutMs?: number;
}): Promise<ProbeOutcome> {
  try {
    const response = await requestGateway({
      gatewayUrl: config.gatewayUrl,
      token: config.token,
      path: CAPABILITIES_PATH,
      method: "GET",
      timeoutMs: config.timeoutMs ?? GATEWAY_FETCH_TIMEOUT_MS,
      ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
    });
    // A rate limit or an outage is no answer: ask again later, and let the cache stand in.
    if (response.status === 429 || response.status >= 500) return { kind: "unreachable" };
    if (response.status !== 200) return { kind: "none" };
    const capabilities = parseCapabilities(response.body);
    return capabilities === undefined ? { kind: "none" } : { kind: "available", capabilities };
  } catch {
    return { kind: "unreachable" };
  }
}

export function defaultCapabilityCacheFile(): string {
  return join(homedir(), ".eragon", "bridge-capabilities.json");
}

type CacheFile = {
  version: 1;
  entries: Record<string, { savedAt: number; capabilities: Capabilities }>;
  /** By key source (a key command) and origin: which key's entry it last read, by the key's SHA-256. */
  sources?: Record<string, { savedAt: number; keyHash: string }>;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

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
export class CapabilityCache {
  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  static entryName(token: string, gatewayUrl: string): string {
    return CapabilityCache.entryNameOfHash(sha256(token), gatewayUrl);
  }

  static keyHash(token: string): string {
    return sha256(token);
  }

  private static entryNameOfHash(keyHash: string, gatewayUrl: string): string {
    return `${keyHash}@${new URL(gatewayUrl).origin}`;
  }

  private static sourceName(source: string, gatewayUrl: string): string {
    return `${sha256(source)}@${new URL(gatewayUrl).origin}`;
  }

  private fresh(savedAt: number): boolean {
    return this.now() - savedAt < CAPABILITY_CACHE_TTL_MS && savedAt <= this.now();
  }

  read(token: string, gatewayUrl: string): Capabilities | undefined {
    return this.readHash(CapabilityCache.keyHash(token), gatewayUrl);
  }

  /** The entry the key source last read, before its key is known; the caller checks the key once it is. */
  readBySource(source: string, gatewayUrl: string): { keyHash: string; capabilities: Capabilities } | undefined {
    const pointer = this.load().sources?.[CapabilityCache.sourceName(source, gatewayUrl)];
    if (pointer === undefined || !this.fresh(pointer.savedAt)) return undefined;
    const capabilities = this.readHash(pointer.keyHash, gatewayUrl);
    return capabilities === undefined ? undefined : { keyHash: pointer.keyHash, capabilities };
  }

  private readHash(keyHash: string, gatewayUrl: string): Capabilities | undefined {
    const entry = this.load().entries[CapabilityCache.entryNameOfHash(keyHash, gatewayUrl)];
    if (entry === undefined || !this.fresh(entry.savedAt)) return undefined;
    return parseCapabilities(entry.capabilities);
  }

  write(token: string, gatewayUrl: string, capabilities: Capabilities, source?: string): void {
    const cache = this.load();
    cache.entries[CapabilityCache.entryName(token, gatewayUrl)] = { savedAt: this.now(), capabilities };
    if (source !== undefined) {
      cache.sources = { ...cache.sources, [CapabilityCache.sourceName(source, gatewayUrl)]: { savedAt: this.now(), keyHash: CapabilityCache.keyHash(token) } };
    }
    this.save(cache);
  }

  remove(token: string, gatewayUrl: string): void {
    const cache = this.load();
    const name = CapabilityCache.entryName(token, gatewayUrl);
    if (!(name in cache.entries)) return;
    delete cache.entries[name];
    this.save(cache);
  }

  private load(): CacheFile {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (isRecord(parsed) && parsed.version === 1 && isRecord(parsed.entries)) {
        const entries: CacheFile["entries"] = {};
        for (const [name, entry] of Object.entries(parsed.entries)) {
          if (isRecord(entry) && typeof entry.savedAt === "number" && isRecord(entry.capabilities)) {
            entries[name] = { savedAt: entry.savedAt, capabilities: entry.capabilities as Capabilities };
          }
        }
        const sources: NonNullable<CacheFile["sources"]> = {};
        for (const [name, pointer] of Object.entries(isRecord(parsed.sources) ? parsed.sources : {})) {
          if (isRecord(pointer) && typeof pointer.savedAt === "number" && typeof pointer.keyHash === "string") {
            sources[name] = { savedAt: pointer.savedAt, keyHash: pointer.keyHash };
          }
        }
        return { version: 1, entries, sources };
      }
    } catch {
      // Missing or unreadable: an empty cache.
    }
    return { version: 1, entries: {} };
  }

  private save(cache: CacheFile): void {
    const now = this.now();
    for (const [name, entry] of Object.entries(cache.entries)) {
      if (!(now - entry.savedAt < CAPABILITY_CACHE_TTL_MS)) delete cache.entries[name];
    }
    for (const [name, pointer] of Object.entries(cache.sources ?? {})) {
      if (!(now - pointer.savedAt < CAPABILITY_CACHE_TTL_MS)) delete cache.sources![name];
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.file);
    } catch {
      // A cache that cannot be written only costs the next slow start its Connections.
    }
  }
}
