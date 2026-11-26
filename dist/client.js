import { VERSION } from "./version.js";
function retryAfterSeconds(header) {
    if (!header)
        return undefined;
    const seconds = /^\d+$/.test(header) ? Number(header) : (Date.parse(header) - Date.now()) / 1000;
    return Number.isFinite(seconds) ? Math.max(0, seconds) : undefined;
}
export async function requestGateway({ gatewayUrl, token, path, method = "POST", body, fetchImpl = fetch, timeoutMs, responseType, retryOnNetworkError = false, }) {
    if (timeoutMs !== undefined && timeoutMs <= 0)
        throw new Error("Eragon request timed out.");
    const base = gatewayUrl.replace(/\/+$/, "");
    const url = `${base}${path}`;
    const init = {
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
    let response;
    try {
        response = await fetchImpl(url, init);
    }
    catch (error) {
        // Node fetch reports a transport failure this way before any response headers.
        if (!retryOnNetworkError || init.signal?.aborted || !(error instanceof TypeError) || error.message !== "fetch failed") {
            throw error;
        }
        response = await fetchImpl(url, init);
    }
    const text = await response.text();
    const retryAfter = retryAfterSeconds(response.headers?.get("retry-after"));
    const result = { status: response.status, ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }) };
    if (responseType === "text" && response.status === 200)
        return { ...result, body: text };
    if (text === "")
        return { ...result, body: null };
    try {
        return { ...result, body: JSON.parse(text) };
    }
    catch {
        return { ...result, body: text };
    }
}
//# sourceMappingURL=client.js.map