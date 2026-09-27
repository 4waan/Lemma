import { useState } from "react";

import { CodeBlock } from "../components/copy.js";
import { Icon } from "../components/Icon.js";
import { Badge, Built } from "../components/ui.js";

const CHECKOUT = "<path to your Lemma checkout>";
const PLACEHOLDER_SERVER = "https://<this server>";
const BRIDGE = `${CHECKOUT}/apps/bridge/dist/main.js`;

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

type AgentId = "cursor" | "claude" | "other";

const AGENTS: ReadonlyArray<{ readonly id: AgentId; readonly label: string }> = [
  { id: "cursor", label: "Cursor" },
  { id: "claude", label: "Claude Code" },
  { id: "other", label: "Other agents" },
];

/** Static: how to build, register and use the local bridge. Nothing here comes from the API. */
export function Setup() {
  const [agent, setAgent] = useState<AgentId>("cursor");
  const server = serverOrigin();
  const stdioConfig = JSON.stringify({ mcpServers: { lemma: { command: "node", args: [BRIDGE], env: { LEMMA_API_URL: server } } } }, null, 2);
  const register: Readonly<Record<AgentId, { title: string; label: string; code: string; note: string }>> = {
    cursor: { title: "Add it to Cursor", label: ".cursor/mcp.json", code: stdioConfig, note: "Paste it into your project's .cursor/mcp.json. The page fills in this server's address." },
    claude: {
      title: "Add it to Claude Code",
      label: "in your project",
      code: `claude mcp add --env LEMMA_API_URL=${server} lemma -- node ${BRIDGE}`,
      note: "Registers the bridge for this project. Check the flags against claude mcp add --help if your version differs.",
    },
    other: { title: "Add it to your agent", label: "MCP configuration", code: stdioConfig, note: "Any MCP client that starts servers over stdio accepts this shape. Use your agent's own file and key names." },
  };
  const rule: Readonly<Record<AgentId, { code: string; note: string }>> = {
    cursor: { code: `node ${BRIDGE} install-rule --agent cursor .`, note: "Writes .cursor/rules/lemma.mdc. It tells the agent to check Lemma before building an x402 integration." },
    claude: { code: `node ${BRIDGE} install-rule --agent claude .`, note: "Writes .claude/rules/lemma.md, which Claude Code loads at the start of every session." },
    other: { code: `node ${BRIDGE} install-rule --agent agents .`, note: "Adds a marked block to AGENTS.md, which many coding agents read. Your own text in the file is left as it is." },
  };
  return (
    <div className="start">
      <aside className="start-aside">
        <span className="eyebrow">Get started</span>
        <h1>Connect your agent</h1>
        <p className="lead">About three minutes. The bridge runs on your machine and never sends your code.</p>
        <div className="need">
          <span className="field-label">You need</span>
          <ul className="check-list">
            <li>
              <Icon name="check" />
              <span>Node 22 or newer</span>
            </li>
            <li>
              <Icon name="check" />
              <span>A copy of the Lemma repository. The bridge is built from a checkout for now.</span>
            </li>
          </ul>
        </div>
      </aside>
      <div>
        <div className="tabs" role="tablist" aria-label="Your agent">
          {AGENTS.map((a) => (
            <button key={a.id} type="button" role="tab" id={`tab-${a.id}`} aria-selected={agent === a.id} aria-controls="setup-steps" onClick={() => setAgent(a.id)}>
              {a.label}
            </button>
          ))}
        </div>
        <ol className="start-steps" id="setup-steps" role="tabpanel" aria-labelledby={`tab-${agent}`}>
          <li>
            <div>
              <h3>Build the bridge</h3>
              <CodeBlock label="in your Lemma checkout" code="npm ci && npm run build" />
            </div>
          </li>
          <li>
            <div>
              <h3>{register[agent].title}</h3>
              <CodeBlock label={register[agent].label} code={register[agent].code} />
              <p className="note">{register[agent].note}</p>
            </div>
          </li>
          <li>
            <div>
              <h3>Install the rule</h3>
              <CodeBlock label="in your project" code={rule[agent].code} />
              <p className="note">{rule[agent].note}</p>
            </div>
          </li>
          <li>
            <div>
              <h3>Ask for an integration</h3>
              <p className="prompt-bubble">Add x402 payment gating to my MCP server.</p>
              <p className="note">Your agent checks Lemma first and follows the answer. In a monorepo it also passes the package directory.</p>
            </div>
          </li>
        </ol>

        <details className="accordion">
          <summary>
            Tools your agent sees <Icon name="chevron" size={18} />
          </summary>
          <div className="accordion-body">
            <p>The bridge answers in short text built from codes and numbers, so catalog prose never reaches the model.</p>
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
          </div>
        </details>

        <details className="accordion">
          <summary>
            Settings and spending limits <Icon name="chevron" size={18} />
          </summary>
          <div className="accordion-body">
            <p>An empty value counts as unset. The state directory must sit outside the workspace.</p>
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
                            <Badge tone="warn">coming soon</Badge>
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
              The buyer key never goes in the bridge's environment: lemma-signer init creates it in a key file, and lemma-signer serve signs within the same limits, which it
              enforces itself. Acceptance tests run as your user, so the verify tool refuses to run while a wallet secret is in the bridge's environment. For full isolation, run
              the signer as another user.
            </p>
          </div>
        </details>

        <details className="accordion">
          <summary>
            What the bridge never does <Icon name="chevron" size={18} />
          </summary>
          <div className="accordion-body">
            <ul className="check-list warn">
              {NEVER.map((item) => (
                <li key={item}>
                  <Icon name="shield" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </details>
      </div>
    </div>
  );
}

const TOOLS: ReadonlyArray<{ readonly name: string; readonly text: string; readonly built: boolean }> = [
  { name: "lemma_preview", text: "Free compatibility check from package metadata. Also checks local files for drift before any purchase.", built: true },
  { name: "lemma_buy_resolution", text: "Pays for an open offer through x402 and your local signer, within your spending limits. Never pays twice.", built: true },
  { name: "lemma_apply_resolution", text: "Previews the patch by default. Applies it all or nothing on request, or exports it to merge by hand.", built: true },
  { name: "lemma_verify_adoption", text: "Runs the release's acceptance tests and records the Adoption Receipt.", built: true },
];

const SETTINGS: ReadonlyArray<{ readonly name: string; readonly text: string; readonly fallback: string; readonly later: boolean }> = [
  { name: "LEMMA_API_URL", text: "This server's address.", fallback: "http://localhost:3000", later: false },
  { name: "LEMMA_WORKSPACE", text: "The repository root the bridge may read. Nothing above it is read.", fallback: "the working directory", later: false },
  { name: "LEMMA_STATE_DIR", text: "Purchases, receipts, apply journals and exports, private to you.", fallback: "~/.local/state/lemma", later: false },
  { name: "LEMMA_ACCEPTANCE_OFFLINE", text: "Set to 1 to run acceptance tests without network, on Linux.", fallback: "off", later: false },
  { name: "LEMMA_SIGNER_SOCKET", text: "The socket of lemma-signer, the separate process that holds the buyer key. Purchases stay off while no signer answers.", fallback: "the signer's own default, <state>/signer/signer.sock", later: false },
  { name: "LEMMA_MAX_USDC_PER_RESOLUTION", text: "The most one purchase may cost, in atomic USDC (250000 is 0.25 USDC).", fallback: "none: purchases stay off", later: false },
  { name: "LEMMA_DAILY_USDC_CAP", text: "The most the bridge may spend in a rolling day, in atomic USDC.", fallback: "none: purchases stay off", later: false },
  { name: "LEMMA_ALLOWED_PAY_TO", text: "The recipient addresses the buyer will pay, comma-separated.", fallback: "none: purchases stay off", later: false },
  { name: "LEMMA_REFUND_TO", text: "Where warranty credits are paid. A withdrawal shows this address on chain, so use another one you control to keep your wallet out of it.", fallback: "the buyer's address", later: false },
];

const NEVER: readonly string[] = [
  "Send source files, file paths or environment values to the server.",
  "Let model text authorize a payment: spending limits are checked in code.",
  "Run a shell string from a release. Acceptance tests are a script name and fixed arguments, spawned without a shell.",
  "Write outside the workspace or through a symbolic link.",
  "Apply a patch over files that changed since it was built. It answers adapt instead.",
];
