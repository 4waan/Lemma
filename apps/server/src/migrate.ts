import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { isPostgresUrl } from "./config.js";
import { MIGRATIONS_FOLDER, latestMigration } from "./db/migrations.js";
import { describeError, isUnparseableUrl } from "./errors.js";

/**
 * Applies pending migrations (deployment step 3). Run it before starting a new
 * server version: `npm run db:migrate -w @lemma/server` with DATABASE_URL set.
 */
const url = process.env["DATABASE_URL"];
if (url === undefined || !isPostgresUrl(url)) {
  // Never print the value: it usually holds a password.
  console.error("DATABASE_URL must be set to a postgres:// URL (special characters in the password URL-encoded)");
  process.exit(1);
}
let client: ReturnType<typeof postgres> | undefined;
try {
  client = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 10 });
  await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
  console.log(`database schema is at ${latestMigration().tag}`);
} catch (error) {
  console.error(isUnparseableUrl(error) ? "DATABASE_URL could not be parsed (URL-encode special characters in the password)" : `migration failed (${describeError(error)})`);
  process.exitCode = 1;
} finally {
  await client?.end();
}
