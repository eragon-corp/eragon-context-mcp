/**
 * Every Gateway request is abandoned after this long (ERA-5056). Codex gives a
 * tool call 60 s by default, so the agent gets the bridge's own answer, which
 * says what to do next, before the client gives up on the call.
 */
export declare const GATEWAY_FETCH_TIMEOUT_MS = 45000;
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
export declare class GatewayTimeoutError extends Error {
    readonly timeoutMs: number;
    constructor(timeoutMs: number);
}
export declare function requestGateway({ gatewayUrl, token, path, method, body, fetchImpl, timeoutMs, }: GatewayRequest): Promise<GatewayResponse>;
//# sourceMappingURL=client.d.ts.map