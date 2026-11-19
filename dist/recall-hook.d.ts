export declare const RECALL_EVENT = "UserPromptSubmit";
/** The timeout written into each client's hook entry. The client kills the hook then and reports an error. */
export declare const RECALL_TIMEOUT_SECONDS = 3;
/**
 * The hook's own deadline, in milliseconds from process start. The client
 * counts its timeout from spawn, so the hook finishes half a second earlier and
 * a slow Gateway costs one silent turn without recall instead of a timeout error.
 */
export declare const RECALL_DEADLINE_MS = 2500;
/** Milliseconds left before the hook's own deadline. `performance.now()` counts from process start. */
export declare function recallTimeLeft(): number;
/**
 * The text to add to the conversation, from a recall reply. The Gateway replies
 * `{ text, count, status }`; any 2xx with non-blank string `text` is a recall.
 */
export declare function recalledText(status: number, body: unknown): string | undefined;
export declare function runRecallHook(config: {
    gatewayUrl: string;
    token: string;
}): Promise<void>;
//# sourceMappingURL=recall-hook.d.ts.map