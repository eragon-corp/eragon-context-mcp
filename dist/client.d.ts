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
export declare function requestGateway({ gatewayUrl, token, path, body, fetchImpl, }: GatewayRequest): Promise<GatewayResponse>;
//# sourceMappingURL=client.d.ts.map