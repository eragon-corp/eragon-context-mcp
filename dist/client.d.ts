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
export declare function requestGateway({ gatewayUrl, token, path, method, body, fetchImpl, timeoutMs, responseType, retryOnNetworkError, }: GatewayRequest): Promise<GatewayResponse>;
//# sourceMappingURL=client.d.ts.map