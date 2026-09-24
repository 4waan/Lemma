import { expect } from "vitest";

export type Parser = {
  safeParse(v: unknown): { success: boolean; error?: { issues: ReadonlyArray<{ path: PropertyKey[] }> } };
};

export function accepts(schema: Parser, value: unknown): void {
  const result = schema.safeParse(value);
  expect(result.error?.issues ?? [], "expected the value to parse").toEqual([]);
  expect(result.success).toBe(true);
}

/** Rejects, and for the expected reason: some issue sits at `path`. */
export function rejectsAt(schema: Parser, value: unknown, path: PropertyKey[]): void {
  const result = schema.safeParse(value);
  expect(result.success, `expected rejection at ${JSON.stringify(path)}`).toBe(false);
  expect(result.error?.issues.map((i) => i.path)).toContainEqual(path);
}

export function rejects(schema: Parser, value: unknown): void {
  expect(schema.safeParse(value).success).toBe(false);
}
