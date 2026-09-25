import { redact } from "@lemma/core";

export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
}

/**
 * One JSON line per event, every field passed through core `redact`, so a
 * credential that reaches a log call never reaches the log. Preview ids are
 * bearer secrets for recovery and are never logged; callers log resolution ids
 * or digests instead.
 */
export function jsonLogger(write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Logger {
  return {
    log(level, event, fields = {}) {
      write(JSON.stringify(redact({ level, event, ...fields })));
    },
  };
}

export const silentLogger: Logger = { log() {} };
