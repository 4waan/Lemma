import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { type Db, sqlState } from "./store.js";

/** `apps/server/drizzle`, from `src/db` in tests and `dist/db` at runtime. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

const Journal = z.object({ entries: z.array(z.object({ tag: z.string(), when: z.number() })).min(1) });

/** The newest migration this build ships (drizzle's journal). */
export function latestMigration(folder: string = MIGRATIONS_FOLDER): { tag: string; when: number } {
  const journal = Journal.parse(JSON.parse(readFileSync(`${folder}/meta/_journal.json`, "utf8")));
  return journal.entries[journal.entries.length - 1] as { tag: string; when: number };
}

/** SQLSTATEs that mean no migration was ever applied: the table or its schema does not exist. */
const NEVER_MIGRATED = new Set(["42P01", "3F000"]);

/**
 * Whether the database holds every migration this build ships. The server
 * refuses to start otherwise (docs/deployment.md step 3): migrations are applied
 * by an explicit deployment step (`npm run db:migrate -w @lemma/server`), never
 * implicitly at startup. Only a missing migrations table means "not migrated";
 * any other error (unreachable, wrong credentials, no permission) is thrown, so
 * it is not mistaken for a schema that is behind.
 */
export async function schemaIsCurrent(
  db: Db,
  folder: string = MIGRATIONS_FOLDER,
  expected: number = latestMigration(folder).when,
): Promise<{ current: boolean; applied: number | null; expected: number }> {
  let applied: number | null = null;
  try {
    const result = await db.execute(sql`select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`);
    const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? []) as Array<{ created_at: string | number }>;
    applied = rows[0] === undefined ? null : Number(rows[0].created_at);
  } catch (error) {
    if (!NEVER_MIGRATED.has(sqlState(error) ?? "")) throw error;
    applied = null;
  }
  return { current: applied !== null && applied >= expected, applied, expected };
}
