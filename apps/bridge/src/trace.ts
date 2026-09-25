import { appendFileSync } from "node:fs";

/**
 * Optional trace for the benchmark harness (LEMMA_BRIDGE_TRACE): one JSON line
 * when a client initializes the bridge, and one per tool call with only the
 * tool name, including calls the SDK rejects for their arguments (a name that
 * is not a Lemma tool is written as "other"). Nothing else, and never
 * arguments or results.
 */
export class Trace {
  constructor(private readonly path: string | undefined) {}

  event(event: "initialize" | "tool", name?: string): void {
    if (this.path === undefined) return;
    try {
      appendFileSync(this.path, `${JSON.stringify(name === undefined ? { event } : { event, name })}\n`);
    } catch {
      // Tracing must never break the bridge.
    }
  }
}
