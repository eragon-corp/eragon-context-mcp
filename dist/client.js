export async function requestGateway({ gatewayUrl, token, path, body, fetchImpl = fetch, }) {
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
    if (text === "")
        return { status: response.status, body: null };
    try {
        return { status: response.status, body: JSON.parse(text) };
    }
    catch {
        return { status: response.status, body: text };
    }
}
//# sourceMappingURL=client.js.map