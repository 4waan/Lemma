import { useState } from "react";

import { CodeBlock } from "../components/copy.js";
import { Icon } from "../components/Icon.js";

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
              <span>A copy of the Lemma repository. The bridge builds from it.</span>
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
            <p>Answers are short codes and numbers, so no catalog text reaches the model.</p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Tool</th>
                    <th scope="col">What it does</th>
                  </tr>
                </thead>
                <tbody>
                  {TOOLS.map((t) => (
                    <tr key={t.name}>
                      <td>
                        <code>{t.name}</code>
                      </td>
                      <td>{t.text}</td>
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
                      </td>
                      <td>{s.text}</td>
                      <td>{s.fallback}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="check-list">
              {KEYS.map((item) => (
                <li key={item}>
                  <Icon name="shield" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
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

const TOOLS: ReadonlyArray<{ readonly name: string; readonly text: string }> = [
  { name: "lemma_preview", text: "Free check from your package list. Before a purchase it also checks that your files have not changed." },
  { name: "lemma_buy_resolution", text: "Pays for an offer through x402 and your local signer, within your limits. Never pays twice." },
  { name: "lemma_apply_resolution", text: "Shows the patch first. Applies it whole or not at all, or exports it to merge by hand." },
  { name: "lemma_verify_adoption", text: "Runs the patch's tests and signs the result." },
  { name: "lemma_claim_refund", text: "Collects the refund for each purchase whose failure was confirmed. Free, and safe to call again." },
];

const SETTINGS: ReadonlyArray<{ readonly name: string; readonly text: string; readonly fallback: string }> = [
  { name: "LEMMA_API_URL", text: "This server's address.", fallback: "http://localhost:3000" },
  { name: "LEMMA_WORKSPACE", text: "The repository root the bridge may read. Nothing above it is read.", fallback: "the working directory" },
  { name: "LEMMA_STATE_DIR", text: "Purchases, receipts, apply journals and exports, private to you.", fallback: "~/.local/state/lemma" },
  { name: "LEMMA_ACCEPTANCE_OFFLINE", text: "Set to 1 to run acceptance tests without network, on Linux.", fallback: "off" },
  {
    name: "LEMMA_AGENT_ID",
    text: "Optional: your agent's ERC-8004 id. Each result then names it, which shows on chain that the paying wallet adopted that patch.",
    fallback: "unset: no agent is named",
  },
  { name: "LEMMA_SIGNER_SOCKET", text: "The socket of lemma-signer, the separate process that holds the buyer key. Purchases stay off while no signer answers.", fallback: "the signer's own default, <state>/signer/signer.sock" },
  { name: "LEMMA_MAX_USDC_PER_RESOLUTION", text: "The most one purchase may cost, in atomic USDC (250000 is 0.25 USDC).", fallback: "none: purchases stay off" },
  { name: "LEMMA_DAILY_USDC_CAP", text: "The most the bridge may spend in a rolling day, in atomic USDC.", fallback: "none: purchases stay off" },
  { name: "LEMMA_ALLOWED_PAY_TO", text: "The recipient addresses the buyer will pay, comma-separated.", fallback: "none: purchases stay off" },
  { name: "LEMMA_REFUND_TO", text: "Where refunds go: an address you control, other than the buyer's. A refund shows it on chain. Purchases need it.", fallback: "none: purchases stay off" },
];

const KEYS: readonly string[] = [
  "The buyer key lives in lemma-signer's key file, never in the bridge's environment.",
  "The signer checks the same spending limits itself before it signs.",
  "Tests run as your user, so the verify tool refuses to run while a wallet secret is in the bridge's environment. For full separation, run the signer as another user.",
];

const NEVER: readonly string[] = [
  "Send source files, file paths or environment values, except LEMMA_AGENT_ID when you set it, to the server.",
  "Let model text authorize a payment: spending limits are checked in code.",
  "Run a shell string from a release. Acceptance tests are a script name and fixed arguments, spawned without a shell.",
  "Write outside the workspace or through a symbolic link.",
  "Apply a patch over files that changed since it was built. It answers adapt instead.",
];
