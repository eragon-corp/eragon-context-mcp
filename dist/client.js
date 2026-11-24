import { VERSION } from "./version.js";
/**
 * A connector tool call, key and every request included, is abandoned after
 * this long (ERA-5056). Codex gives a tool call 60 s by default, so the agent
 * gets the bridge's own answer, which says what to do next, before the
 * client gives up on the call. Memory requests keep the base bridge's
 * behaviour and have no bridge deadline: a save that answers late still
 * returns its receipt.
 */
export const GATEWAY_FETCH_TIMEOUT_MS = 45_000;
/** The Gateway did not answer in time; the request was abandoned. */
export class GatewayTimeoutError extends Error {
    timeoutMs;
    constructor(timeoutMs) {
        super(`Eragon did not answer within ${Math.round(timeoutMs / 1000)} s.`);
        this.timeoutMs = timeoutMs;
        this.name = "GatewayTimeoutError";
    }
}
export async function requestGateway({ gatewayUrl, token, path, method = "POST", body, fetchImpl = fetch, timeoutMs, }) {
    const base = gatewayUrl.replace(/\/+$/, "");
    const controller = new AbortController();
    if (timeoutMs !== undefined && timeoutMs <= 0)
        throw new GatewayTimeoutError(0);
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(new GatewayTimeoutError(timeoutMs)), timeoutMs);
    try {
        const headers = {
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
            ...(timer === undefined ? {} : { signal: controller.signal }),
        });
        const text = await response.text();
        const retryAfter = Number(response.headers?.get?.("retry-after") ?? Number.NaN);
        const extra = Number.isFinite(retryAfter) && retryAfter >= 0 ? { retryAfterSeconds: retryAfter } : {};
        if (text === "")
            return { status: response.status, body: null, ...extra };
        try {
            return { status: response.status, body: JSON.parse(text), ...extra };
        }
        catch {
            return { status: response.status, body: text, ...extra };
        }
    }
    catch (error) {
        // A fetch that honours the signal rejects with its reason or an AbortError; either is the deadline.
        if (controller.signal.aborted)
            throw new GatewayTimeoutError(timeoutMs ?? 0);
        throw error;
    }
    finally {
        clearTimeout(timer);
    }
}
//# sourceMappingURL=client.js.map