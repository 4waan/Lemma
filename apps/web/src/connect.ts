/**
 * Install links and commands for the local bridge, one per coding agent. All
 * of them come from one server definition, so the Cursor, VS Code and Goose
 * links can never drift from the commands. The bridge itself is served by the
 * Lemma server at /dl/ (apps/bridge/scripts/pack.mjs).
 */

/** The bridge package version the server serves (apps/bridge/package.json). */
export const BRIDGE_VERSION = "0.1.0";

/** The name agents list the server under. */
export const SERVER_NAME = "lemma";

export interface Install {
  /** The packed bridge on this server, for `npx -y`. */
  readonly packageUrl: string;
  readonly cursorUrl: string;
  readonly vscodeUrl: string;
  readonly gooseUrl: string;
  readonly claudeCommand: string;
  readonly codexCommand: string;
  readonly codexToml: string;
  readonly genericJson: string;
  /** `npx` running one of the package's two commands: `lemma-mcp` or `lemma-signer`. */
  readonly run: (bin: "lemma-mcp" | "lemma-signer", args: string) => string;
}

function base64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Every way to add the bridge for the server at `origin`, an http(s) origin with no path. */
export function installFor(origin: string): Install {
  const packageUrl = `${origin}/dl/lemma-mcp-${BRIDGE_VERSION}.tgz`;
  const launch = { command: "npx", args: ["-y", packageUrl] };
  const env = { LEMMA_API_URL: origin };
  // Cursor expands ${workspaceFolder} to the open project, so the bridge reads that project and nothing above it.
  // VS Code's one-click install writes the user's own settings, where ${workspaceFolder} is not defined and the
  // server would not start, so its config leaves it out: the bridge then reads the folder VS Code starts it in.
  const editor = { ...launch, env: { ...env, LEMMA_WORKSPACE: "${workspaceFolder}" } };
  const vscode = { type: "stdio", ...launch, env };
  const goose = new URLSearchParams([
    ["cmd", launch.command],
    ...launch.args.map((arg): [string, string] => ["arg", arg]),
    ["id", SERVER_NAME],
    ["name", "Lemma"],
    ["description", "Tested integrations for your coding agent"],
  ]);
  return {
    packageUrl,
    cursorUrl: `https://cursor.com/en/install-mcp?name=${SERVER_NAME}&config=${encodeURIComponent(base64(JSON.stringify(editor)))}`,
    vscodeUrl: `https://vscode.dev/redirect/mcp/install?name=${SERVER_NAME}&config=${encodeURIComponent(JSON.stringify(vscode))}`,
    gooseUrl: `goose://extension?${goose.toString()}`,
    claudeCommand: `claude mcp add -s local -t stdio -e LEMMA_API_URL=${origin} ${SERVER_NAME} -- npx -y ${packageUrl}`,
    codexCommand: `codex mcp add ${SERVER_NAME} --env LEMMA_API_URL=${origin} -- npx -y ${packageUrl}`,
    codexToml: [`[mcp_servers.${SERVER_NAME}]`, `command = "npx"`, `args = ["-y", "${packageUrl}"]`, `env = { LEMMA_API_URL = "${origin}" }`, "startup_timeout_sec = 60"].join("\n"),
    genericJson: JSON.stringify({ mcpServers: { [SERVER_NAME]: { ...launch, env } } }, null, 2),
    run: (bin, args) => `npx -y -p ${packageUrl} ${bin} ${args}`,
  };
}
