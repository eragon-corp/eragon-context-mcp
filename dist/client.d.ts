/**
 * A connector tool call, key and every request included, is abandoned after
 * this long (ERA-5056). Codex gives a tool call 60 s by default, so the agent
 * gets the bridge's own answer, which says what to do next, before the
 * client gives up on the call. Memory requests keep the base bridge's
 * behaviour and have no bridge deadline: a save that answers late still
 * returns its receipt.
 */
export declare const GATEWAY_FETCH_TIMEOUT_MS = 45000;
export type GatewayResponse = {
    status: number;
    body: unknown;
    /** Seconds from a `retry-after` header (the Gateway's 429 and 503), when it sent one. */
    retryAfterSeconds?: number;
};
export type GatewayRequest = {
    gatewayUrl: string;
    token: string;
    path: string;
    /** POST unless named; a GET sends no body. */
    method?: "GET" | "POST";
    body?: unknown;
    fetchImpl?: typeof fetch;
    /** Abandon the request after this long; none when omitted (the Memory requests). */
    timeoutMs?: number;
};
/** The Gateway did not answer in time; the request was abandoned. */
export declare class GatewayTimeoutError extends Error {
    readonly timeoutMs: number;
    constructor(timeoutMs: number);
}
export declare function requestGateway({ gatewayUrl, token, path, method, body, fetchImpl, timeoutMs, }: GatewayRequest): Promise<GatewayResponse>;
//# sourceMappingURL=client.d.ts.map