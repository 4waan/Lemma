import { config } from "zod";

// zod 4 probes for eval support with Function(""), which the dashboard's CSP
// (no 'unsafe-eval') refuses and reports on every page load. Imported first in
// main.tsx, before anything that builds a schema, so the probe never runs.
config({ jitless: true });
