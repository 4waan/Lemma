import { defineConfig } from "drizzle-kit";

// Generates SQL migrations from src/db/schema.ts into drizzle/ (npm run db:generate -w @lemma/server).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
