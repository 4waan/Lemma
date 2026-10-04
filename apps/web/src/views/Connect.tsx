import { useState } from "react";

import { CodeBlock } from "../components/copy.js";
import { Icon } from "../components/Icon.js";
import { installFor } from "../connect.js";

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

type AgentId = "cursor" | "vscode" | "claude" | "codex" | "goose" | "other";

const AGENTS: ReadonlyArray<{ readonly id: AgentId; readonly label: string }> = [
  { id: "cursor", label: "Cursor" },
  { id: "vscode", label: "VS Code" },
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "goose", label: "Goose" },
  { id: "other", label: "Other" },
];

/** Which rule file `install-rule` writes for each agent: its own where it has one, else AGENTS.md. */
const RULE: Readonly<Record<AgentId, { agent: "cursor" | "claude" | "agents"; note: string }>> = {
  cursor: { agent: "cursor", note: "Writes .cursor/rules/lemma.mdc, so Cursor checks Lemma before it builds an integration." },
  claude: { agent: "claude", note: "Writes .claude/rules/lemma.md, which Claude Code loads in every session." },
  vscode: { agent: "agents", note: "Adds a short block to AGENTS.md, which the agent reads. Your own text stays as it is." },
  codex: { agent: "agents", note: "Adds a short block to AGENTS.md, which Codex reads. Your own text stays as it is." },
  goose: { agent: "agents", note: "Adds a short block to AGENTS.md. Your own text stays as it is." },
  other: { agent: "agents", note: "Adds a short block to AGENTS.md, which many agents read. Your own text stays as it is." },
};

/** Static: how to add the bridge to an agent, in one click where the agent has an install link. Nothing here comes from the API. */
export function Connect() {
  const [agent, setAgent] = useState<AgentId>("cursor");
  const install = installFor(serverOrigin());
  return (
    <div className="start">
      <aside className="start-aside">
        <span className="eyebrow">Connect</span>
        <h1>Connect your agent</h1>
        <p className="lead">One click or one command. The bridge runs on your machine and never sends your code.</p>
        <div className="need">
          <span className="field-label">You need</span>
          <ul className="check-list">
            <li>
              <Icon name="check" />
              <span>Node 22 or newer</span>
            </li>
            <li>
              <Icon name="check" />
              <span>Nothing else. Checks are free and work straight away.</span>
            </li>
          </ul>
        </div>
      </aside>
      <div>
        <div className="tabs" role="tablist" aria-label="Your agent">
          {AGENTS.map((a) => (
            <button key={a.id} type="button" role="tab" id={`tab-${a.id}`} aria-selected={agent === a.id} aria-controls="connect-steps" onClick={() => setAgent(a.id)}>
              {a.label}
            </button>
          ))}
        </div>
        <ol className="start-steps" id="connect-steps" role="tabpanel" aria-labelledby={`tab-${agent}`}>
          <li>
            <div>
              <h3>Add Lemma to {AGENTS.find((a) => a.id === agent)?.label}</h3>
              <AddStep agent={agent} install={install} />
            </div>
          </li>
          <li>
            <div>
              <h3>Tell your agent to check Lemma</h3>
              <CodeBlock label="in your project" code={install.run("lemma-mcp", `install-rule --agent ${RULE[agent].agent} .`)} />
              <p className="note">{RULE[agent].note}</p>
            </div>
          </li>
          <li>
            <div>
              <h3>Ask for an integration</h3>
              <p className="prompt-bubble">Add x402 payment gating to my MCP server.</p>
              <p className="note">Your agent checks Lemma first and follows the answer.</p>
            </div>
          </li>
        </ol>

        <details className="accordion">
          <summary>
            Turn on buying <Icon name="chevron" size={18} />
          </summary>
          <div className="accordion-body">
            <p>Checks need no wallet. To buy, run the signer: a separate process that holds the buyer key, so your agent never does.</p>
            <ol className="plain-steps">
              <li>
                <CodeBlock label="create the buyer key" code={install.run("lemma-signer", "init")} />
                <p className="note">It prints the address to fund with Arbitrum Sepolia USDC. The key stays in a file only you can read.</p>
              </li>
              <li>
                <CodeBlock label="start the signer" code={install.run("lemma-signer", "serve")} />
                <p className="note">Set your spending limits first (Settings below). With no limits, nothing is bought.</p>
              </li>
            </ol>
          </div>
        </details>
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

/** The first step for one agent: its install link as a button where it has one, else the command or file to paste. */
function AddStep({ agent, install }: { agent: AgentId; install: ReturnType<typeof installFor> }) {
  switch (agent) {
    case "cursor":
      return <InstallButton href={install.cursorUrl} label="Add to Cursor" note="Opens Cursor and asks you to confirm." />;
    case "vscode":
      return <InstallButton href={install.vscodeUrl} label="Install in VS Code" note="Opens VS Code and asks you to confirm. Use it in agent mode." />;
    case "goose":
      return <InstallButton href={install.gooseUrl} label="Add to Goose" note="Opens Goose and asks you to confirm." />;
    case "claude":
      return (
        <>
          <CodeBlock label="in your project" code={install.claudeCommand} />
          <p className="note">Run it once in your project folder.</p>
        </>
      );
    case "codex":
      return (
        <>
          <CodeBlock label="once" code={install.codexCommand} />
          <p className="note">Or add this to ~/.codex/config.toml:</p>
          <CodeBlock label="config.toml" code={install.codexToml} />
        </>
      );
    case "other":
      return (
        <>
          <CodeBlock label="MCP configuration" code={install.genericJson} />
          <p className="note">For Windsurf, Zed, Cline and any agent that reads an mcpServers file.</p>
        </>
      );
  }
}

function InstallButton({ href, label, note }: { href: string; label: string; note: string }) {
  return (
    <>
      <a className="btn btn-primary install-btn" href={href} rel="noopener noreferrer">
        {label} <Icon name="external" size={16} />
      </a>
      <p className="note">{note}</p>
    </>
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
  { name: "LEMMA_API_URL", text: "This server's address. The install links and commands above set it.", fallback: "this server" },
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
