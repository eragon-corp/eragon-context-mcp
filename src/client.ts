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
};

export async function requestGateway({
  gatewayUrl,
  token,
  path,
  body,
  fetchImpl = fetch,
}: GatewayRequest): Promise<GatewayResponse> {
  const base = gatewayUrl.replace(/\/+$/, "");
  const response = await fetchImpl(`${base}${path}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    redirect: "manual",
  });
  const text = await response.text();
  if (text === "") return { status: response.status, body: null };
  try {
    return { status: response.status, body: JSON.parse(text) as unknown };
  } catch {
    return { status: response.status, body: text };
  }
}
