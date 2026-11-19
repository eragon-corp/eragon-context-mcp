import { addAbortSignal } from "node:stream";
import { requestGateway } from "./client.js";

export const RECALL_EVENT = "UserPromptSubmit";
/** The timeout written into each client's hook entry. The client kills the hook then and reports an error. */
export const RECALL_TIMEOUT_SECONDS = 3;
/**
 * The hook's own deadline, in milliseconds from process start. The client
 * counts its timeout from spawn, so the hook finishes half a second earlier and
 * a slow Gateway costs one silent turn without recall instead of a timeout error.
 */
export const RECALL_DEADLINE_MS = 2500;

/** Milliseconds left before the hook's own deadline. `performance.now()` counts from process start. */
export function recallTimeLeft(): number {
  return Math.max(0, Math.floor(RECALL_DEADLINE_MS - performance.now()));
}

/**
 * The text to add to the conversation, from a recall reply. The Gateway replies
 * `{ text, count, status }`; any 2xx with non-blank string `text` is a recall.
 */
export function recalledText(status: number, body: unknown): string | undefined {
  if (status < 200 || status >= 300) return undefined;
  if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
  const { text } = body as { text?: unknown };
  return typeof text === "string" && text.trim() !== "" ? text : undefined;
}

export async function runRecallHook(config: { gatewayUrl: string; token: string }): Promise<void> {
  try {
    const left = recallTimeLeft();
    const deadline = performance.now() + left;
    const signal = AbortSignal.timeout(left);
    let input = "";
    for await (const chunk of addAbortSignal(signal, process.stdin.setEncoding("utf8"))) {
      input += chunk;
    }
    const event = JSON.parse(input) as { prompt?: unknown; hook_event_name?: unknown } | null;
    if (typeof event?.prompt !== "string" || event.prompt.trim() === "") return;
    if (event.hook_event_name !== undefined && event.hook_event_name !== RECALL_EVENT) return;
    if (performance.now() >= deadline) return;

    const response = await requestGateway({
      ...config,
      path: "/v1/memory/recall",
      body: { query: event.prompt },
      signal,
    });
    const text = recalledText(response.status, response.body);
    if (text === undefined) return;
    const output = JSON.stringify({
      hookSpecificOutput: { hookEventName: RECALL_EVENT, additionalContext: text },
    });
    if (performance.now() < deadline) process.stdout.write(`${output}\n`);
  } catch {
    // Recall is optional. Invalid input, cancelled I/O and network errors are silent.
  }
}
