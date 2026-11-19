import { VERSION } from "./version.js";

export type GatewayResponse = {
  status: number;
  body: unknown;
};

export type GatewayRequest = {
  gatewayUrl: string;
  token: string;
  path: string;
  body: unknown;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

export async function requestGateway({
  gatewayUrl,
  token,
  path,
  body,
  fetchImpl = fetch,
  signal,
}: GatewayRequest): Promise<GatewayResponse> {
  const base = gatewayUrl.replace(/\/+$/, "");
  const response = await fetchImpl(`${base}${path}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": `eragon-context-mcp/${VERSION}`,
    },
    body: JSON.stringify(body),
    redirect: "manual",
    ...(signal === undefined ? {} : { signal }),
  });
  const text = await response.text();
  if (text === "") return { status: response.status, body: null };
  try {
    return { status: response.status, body: JSON.parse(text) as unknown };
  } catch {
    return { status: response.status, body: text };
  }
}
