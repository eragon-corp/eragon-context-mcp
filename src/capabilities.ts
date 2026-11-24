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

export type ConnectorEffect = "read" | "write";
export type ConnectorToolSummary = { id: string; app: string; effect: ConnectorEffect };
export type Capabilities = { version: 1; apps: string[]; tools: ConnectorToolSummary[] };

/**
 * - `available`: the Gateway serves Connections to this key.
 * - `none`: it answered that it does not (404 from a server without the
 *   endpoint, a workspace or key without the grant, a refused key, or an
 *   answer this bridge does not understand). Definitive until a restart.
 * - `unreachable`: no answer (network, timeout, 5xx, or no key yet).
 */
export type ProbeOutcome =
  | { kind: "available"; capabilities: Capabilities }
  | { kind: "none" }
  | { kind: "unreachable" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The capabilities answer, or undefined when it is not one this bridge understands. */
export function parseCapabilities(body: unknown): Capabilities | undefined {
  if (!isRecord(body) || body.version !== CAPABILITIES_VERSION) return undefined;
  const apps = Array.isArray(body.apps) ? body.apps.filter((app): app is string => typeof app === "string" && app !== "") : [];
  if (apps.length === 0) return undefined;
  const tools: ConnectorToolSummary[] = [];
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    if (!isRecord(tool) || typeof tool.id !== "string" || tool.id === "") continue;
    if (tool.effect !== "read" && tool.effect !== "write") continue;
    tools.push({ id: tool.id, app: typeof tool.app === "string" ? tool.app : "", effect: tool.effect });
  }
  return { version: CAPABILITIES_VERSION, apps, tools };
}

export async function probeCapabilities(config: {
  gatewayUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<ProbeOutcome> {
  try {
    const response = await requestGateway({
      gatewayUrl: config.gatewayUrl,
      token: config.token,
      path: CAPABILITIES_PATH,
      method: "GET",
      ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
    });
    if (response.status >= 500) return { kind: "unreachable" };
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

type CacheFile = { version: 1; entries: Record<string, { savedAt: number; capabilities: Capabilities }> };

/**
 * The last capabilities answer per key and Gateway origin, so a slow start
 * still lists Connections the key had yesterday. An entry is named by the
 * key's SHA-256 and the origin: the file never holds the key. Any problem
 * reading or writing it is treated as an empty cache.
 */
export class CapabilityCache {
  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  static entryName(token: string, gatewayUrl: string): string {
    return `${createHash("sha256").update(token).digest("hex")}@${new URL(gatewayUrl).origin}`;
  }

  read(token: string, gatewayUrl: string): Capabilities | undefined {
    const entry = this.load().entries[CapabilityCache.entryName(token, gatewayUrl)];
    if (entry === undefined || !(this.now() - entry.savedAt < CAPABILITY_CACHE_TTL_MS) || entry.savedAt > this.now()) {
      return undefined;
    }
    return parseCapabilities(entry.capabilities);
  }

  write(token: string, gatewayUrl: string, capabilities: Capabilities): void {
    const cache = this.load();
    cache.entries[CapabilityCache.entryName(token, gatewayUrl)] = { savedAt: this.now(), capabilities };
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
        return { version: 1, entries };
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
