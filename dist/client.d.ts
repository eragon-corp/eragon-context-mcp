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
export declare function requestGateway({ gatewayUrl, token, path, body, fetchImpl, signal, }: GatewayRequest): Promise<GatewayResponse>;
//# sourceMappingURL=client.d.ts.map