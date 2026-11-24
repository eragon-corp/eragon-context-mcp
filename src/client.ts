import { VERSION } from "./version.js";

/**
 * Every Gateway request is abandoned after this long (ERA-5056). Codex gives a
 * tool call 60 s by default, so the agent gets the bridge's own answer, which
 * says what to do next, before the client gives up on the call.
 */
export const GATEWAY_FETCH_TIMEOUT_MS = 45_000;

export type GatewayResponse = {
  status: number;
  body: unknown;
};

export type GatewayRequest = {
  gatewayUrl: string;
  token: string;
  path: string;
  /** POST unless named; a GET sends no body. */
  method?: "GET" | "POST";
  body?: unknown;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/** The Gateway did not answer in time; the request was abandoned. */
export class GatewayTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Eragon did not answer within ${Math.round(timeoutMs / 1000)} s.`);
    this.name = "GatewayTimeoutError";
  }
}

export async function requestGateway({
  gatewayUrl,
  token,
  path,
  method = "POST",
  body,
  fetchImpl = fetch,
  timeoutMs = GATEWAY_FETCH_TIMEOUT_MS,
}: GatewayRequest): Promise<GatewayResponse> {
  const base = gatewayUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new GatewayTimeoutError(timeoutMs)), timeoutMs);
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
      "user-agent": `eragon-context-mcp/${VERSION}`,
    };
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers,
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      redirect: "manual",
      signal: controller.signal,
    });
    const text = await response.text();
    if (text === "") return { status: response.status, body: null };
    try {
      return { status: response.status, body: JSON.parse(text) as unknown };
    } catch {
      return { status: response.status, body: text };
    }
  } catch (error) {
    // A fetch that honours the signal rejects with its reason or an AbortError; either is the deadline.
    if (controller.signal.aborted) throw new GatewayTimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
