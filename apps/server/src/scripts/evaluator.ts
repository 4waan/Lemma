/**
 * The evaluator's operator command: failed outcomes the warranty pipeline
 * holds for a decision (`EVALUATOR_FAILURES=review`, the default).
 *
 *   npm run evaluator -w @lemma/server -- list
 *   npm run evaluator -w @lemma/server -- decide <resolutionId> failed|void
 *
 * In the server's container: `node apps/server/dist/scripts/evaluator.js list`.
 * `list` prints each one waiting (resolution id, release, profile, the
 * receipt's outcome and exit code, how long it has waited; nothing about the
 * buyer). `decide` queues it as FAILED (the buyer's credit) or VOID (no
 * credit, bond released, nothing recorded); the evaluator job in the running
 * server signs and sends it. It reads DATABASE_URL and needs no key.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { isPostgresUrl } from "../config.js";
import { describeError, isUnparseableUrl } from "../errors.js";
import { parseEvaluatorArgs, runEvaluatorCommand } from "../warranty/review.js";

function fail(message: string): never {
  console.error(`evaluator: ${message}`);
  process.exit(1);
}

const args = parseEvaluatorArgs(process.argv.slice(2));
if ("error" in args) fail(args.error);
const url = process.env["DATABASE_URL"];
// Never print the value: it usually holds a password.
if (url === undefined || !isPostgresUrl(url)) fail("DATABASE_URL must be set to a postgres:// URL (special characters in the password URL-encoded)");

let client: ReturnType<typeof postgres> | undefined;
try {
  client = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 10 });
  const result = await runEvaluatorCommand(drizzle(client), args, new Date());
  for (const line of result.lines) console.log(line);
  if (result.error !== null) {
    console.error(`evaluator: ${result.error}`);
    process.exitCode = 1;
  }
} catch (error) {
  // Only the error's name and code: a driver message can carry the connection string or SQL.
  console.error(isUnparseableUrl(error) ? "evaluator: DATABASE_URL could not be parsed (URL-encode special characters in the password)" : `evaluator: failed (${describeError(error)})`);
  process.exitCode = 1;
} finally {
  await client?.end();
}
