import { addAbortSignal } from "node:stream";
import { requestGateway } from "./client.js";

export const RECALL_EVENT = "UserPromptSubmit";
export const RECALL_TIMEOUT_SECONDS = 3;

export async function runRecallHook(config: { gatewayUrl: string; token: string }): Promise<void> {
  const deadline = performance.now() + RECALL_TIMEOUT_SECONDS * 1000;
  const signal = AbortSignal.timeout(RECALL_TIMEOUT_SECONDS * 1000);
  try {
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
    if (response.status < 200 || response.status >= 300) return;
    const reply = response.body as { ok?: unknown; text?: unknown } | null;
    if (reply?.ok !== true || typeof reply.text !== "string" || reply.text.trim() === "") return;
    const output = JSON.stringify({
      hookSpecificOutput: { hookEventName: RECALL_EVENT, additionalContext: reply.text },
    });
    if (performance.now() < deadline) process.stdout.write(`${output}\n`);
  } catch {
    // Recall is optional. Invalid input, cancelled I/O and network errors are silent.
  }
}
