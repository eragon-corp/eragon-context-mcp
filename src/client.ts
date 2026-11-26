import { VERSION } from "./version.js";

export type GatewayResponse = {
  status: number;
  body: unknown;
};

export type GatewayRequest = {
  gatewayUrl: string;
  token: string;
  path: string;
  method?: "GET" | "POST";
  body?: unknown;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  responseType?: "text";
  retryOnNetworkError?: boolean;
};

export async function requestGateway({
  gatewayUrl,
  token,
  path,
  method = "POST",
  body,
  fetchImpl = fetch,
  timeoutMs,
  responseType,
  retryOnNetworkError = false,
}: GatewayRequest): Promise<GatewayResponse> {
  if (timeoutMs !== undefined && timeoutMs <= 0) throw new Error("Eragon request timed out.");
  const base = gatewayUrl.replace(/\/+$/, "");
  const url = `${base}${path}`;
  const init: RequestInit = {
    method,
    headers: {
      accept: responseType === "text" ? "text/plain, application/json" : "application/json",
      authorization: `Bearer ${token}`,
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
      "user-agent": `eragon-context-mcp/${VERSION}`,
    },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    redirect: "manual",
    ...(timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(timeoutMs) }),
  };
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    // Node fetch reports a transport failure this way before any response headers.
    if (!retryOnNetworkError || init.signal?.aborted || !(error instanceof TypeError) || error.message !== "fetch failed") {
      throw error;
    }
    response = await fetchImpl(url, init);
  }
  const text = await response.text();
  if (responseType === "text" && response.status === 200) return { status: response.status, body: text };
  if (text === "") return { status: response.status, body: null };
  try {
    return { status: response.status, body: JSON.parse(text) as unknown };
  } catch {
    return { status: response.status, body: text };
  }
}
