import { CodeBlock } from "../components/copy.js";
import { Icon } from "../components/Icon.js";
import { Badge, Built, Callout, PageHead, Section } from "../components/ui.js";

const CHECKOUT = "<path to your Lemma checkout>";
const PLACEHOLDER_SERVER = "https://<this server>";

/**
 * Where the bridge should reach this server. The built dashboard is served by
 * the Lemma server itself, so its origin is the answer; the Vite dev server
 * only proxies /api, so development points at the server's default port.
 */
export function serverOrigin(): string {
  if (typeof window === "undefined") return PLACEHOLDER_SERVER;
  if (import.meta.env.DEV) return "http://localhost:3000";
  const { origin } = window.location;
  return /^https?:\/\/[^/]+$/.test(origin) ? origin : PLACEHOLDER_SERVER;
}

/** Static: how to build, register and use the local bridge. Nothing here comes from the API. */
export function Setup() {
  const mcpConfig = JSON.stringify({ mcpServers: { lemma: { command: "node", args: [`${CHECKOUT}/apps/bridge/dist/main.js`], env: { LEMMA_API_URL: serverOrigin() } } } }, null, 2);
  return (
    <>
      <PageHead eyebrow="Setup" title="Connect your coding agent">
        <p className="lead">
          The Lemma bridge is a local MCP server that runs beside your agent. It keeps repository access, spending limits and patch application on your machine, and asks this
          server for previews.
        </p>
      </PageHead>
      <Callout title="Built from a checkout for now">
        <p>The bridge is not published as a package yet. Build it from a Lemma checkout with Node 22 or newer.</p>
      </Callout>
      <ol className="setup-steps">
        <li>
          <h3>Build the bridge</h3>
          <CodeBlock label="in your Lemma checkout" code={"npm ci\nnpm run build"} />
        </li>
        <li>
          <h3>Register it with your agent</h3>
          <p>
            Add the bridge to your agent's MCP configuration. For Cursor that is <code>.cursor/mcp.json</code>.
          </p>
          <CodeBlock label=".cursor/mcp.json" code={mcpConfig} />
        </li>
        <li>
          <h3>Install the Lemma rule</h3>
          <p>The rule tells the agent to call lemma_preview before building an x402 integration. It stays under 600 characters, because the agent reads it on every turn.</p>
          <CodeBlock label="in your project" code={`node ${CHECKOUT}/apps/bridge/dist/main.js install-rule .`} />
        </li>
        <li>
          <h3>Ask for the integration</h3>
          <p>
            Ask your agent to add x402 payment gating to a TypeScript MCP server, or to build an x402-paying MCP client. It checks with Lemma first and follows the answer. In a
            monorepo it passes the package directory.
          </p>
        </li>
      </ol>

      <Section title="Tools your agent sees" intro="The bridge answers in short text built from codes and numbers, so catalog prose never reaches the model.">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Tool</th>
                <th scope="col">What it does</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {TOOLS.map((t) => (
                <tr key={t.name}>
                  <td>
                    <code>{t.name}</code>
                  </td>
                  <td>{t.text}</td>
                  <td>
                    <Built built={t.built} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Configuration" intro="An empty value counts as unset. The state directory must sit outside the workspace.">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Variable</th>
                <th scope="col">Meaning</th>
                <th scope="col">Default</th>
              </tr>
            </thead>
            <tbody>
              {SETTINGS.map((s) => (
                <tr key={s.name}>
                  <td>
                    <code>{s.name}</code>
                    {s.later ? (
                      <>
                        {" "}
                        <Badge tone="warn">payment work</Badge>
                      </>
                    ) : null}
                  </td>
                  <td>{s.text}</td>
                  <td>{s.fallback}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">
          Keep the buyer key out of the bridge's environment: acceptance tests run as your user and could read it, so the verify tool refuses to run while a wallet secret is
          present. Use a signer that runs as another user, or a hardware or remote signer.
        </p>
      </Section>

      <Section title="What the bridge never does">
        <ul className="check-list warn">
          {NEVER.map((item) => (
            <li key={item}>
              <Icon name="shield" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Agent support">
        <p>Cursor is supported today through its MCP configuration and rules. Any MCP client can start the bridge over stdio; the rule file is specific to Cursor.</p>
      </Section>
    </>
  );
}

const TOOLS: ReadonlyArray<{ readonly name: string; readonly text: string; readonly built: boolean }> = [
  { name: "lemma_preview", text: "Free compatibility check from package metadata. Also checks local files for drift before any purchase.", built: true },
  { name: "lemma_buy_resolution", text: "Pays for an open offer through x402, within your local spending caps.", built: false },
  { name: "lemma_apply_resolution", text: "Previews the patch by default. Applies it all or nothing on request, or exports it to merge by hand.", built: true },
  { name: "lemma_verify_adoption", text: "Runs the release's acceptance tests and records the Adoption Receipt.", built: true },
];

const SETTINGS: ReadonlyArray<{ readonly name: string; readonly text: string; readonly fallback: string; readonly later: boolean }> = [
  { name: "LEMMA_API_URL", text: "This server's address.", fallback: "http://localhost:3000", later: false },
  { name: "LEMMA_WORKSPACE", text: "The repository root the bridge may read. Nothing above it is read.", fallback: "the working directory", later: false },
  { name: "LEMMA_STATE_DIR", text: "Purchases, receipts, apply journals and exports, private to you.", fallback: "~/.local/state/lemma", later: false },
  { name: "LEMMA_ACCEPTANCE_OFFLINE", text: "Set to 1 to run acceptance tests without network, on Linux.", fallback: "off", later: false },
  { name: "LEMMA_MAX_USDC_PER_RESOLUTION", text: "The most one purchase may cost.", fallback: "0.25 in .env.example", later: true },
  { name: "LEMMA_DAILY_USDC_CAP", text: "The most the bridge may spend in a day.", fallback: "1.00 in .env.example", later: true },
  { name: "ARBITRUM_SEPOLIA_RPC_URL", text: "RPC endpoint for payments and warranty activation.", fallback: "none", later: true },
];

const NEVER: readonly string[] = [
  "Send source files, file paths or environment values to the server.",
  "Let model text authorize a payment: spending limits are checked in code.",
  "Run a shell string from a release. Acceptance tests are a script name and fixed arguments, spawned without a shell.",
  "Write outside the workspace or through a symbolic link.",
  "Apply a patch over files that changed since it was built. It answers adapt instead.",
];
