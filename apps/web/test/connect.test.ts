import { describe, expect, it } from "vitest";

import { BRIDGE_VERSION, installFor } from "../src/connect.js";

const ORIGIN = "https://lemma.example";
const PACKAGE = `${ORIGIN}/dl/lemma-mcp-${BRIDGE_VERSION}.tgz`;

describe("install links and commands", () => {
  const install = installFor(ORIGIN);

  it("points every agent at the bridge this server serves, and at this server", () => {
    expect(install.packageUrl).toBe(PACKAGE);
    expect(install.claudeCommand).toBe(`claude mcp add -s local -t stdio -e LEMMA_API_URL=${ORIGIN} lemma -- npx -y ${PACKAGE}`);
    expect(install.codexCommand).toBe(`codex mcp add lemma --env LEMMA_API_URL=${ORIGIN} -- npx -y ${PACKAGE}`);
    expect(install.codexToml).toContain(`args = ["-y", "${PACKAGE}"]`);
    expect(install.codexToml).toContain(`env = { LEMMA_API_URL = "${ORIGIN}" }`);
    expect(JSON.parse(install.genericJson)).toEqual({ mcpServers: { lemma: { command: "npx", args: ["-y", PACKAGE], env: { LEMMA_API_URL: ORIGIN } } } });
    expect(install.run("lemma-signer", "init")).toBe(`npx -y -p ${PACKAGE} lemma-signer init`);
  });

  it("encodes Cursor's config as base64 JSON, and gives editors the open project as the workspace", () => {
    const url = new URL(install.cursorUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://cursor.com/en/install-mcp");
    expect(url.searchParams.get("name")).toBe("lemma");
    const config = JSON.parse(atob(url.searchParams.get("config") ?? ""));
    expect(config).toEqual({ command: "npx", args: ["-y", PACKAGE], env: { LEMMA_API_URL: ORIGIN, LEMMA_WORKSPACE: "${workspaceFolder}" } });
  });

  it("gives VS Code a stdio config with no editor variable, and Goose the command as repeated arguments", () => {
    const vscode = new URL(install.vscodeUrl);
    expect(`${vscode.origin}${vscode.pathname}`).toBe("https://vscode.dev/redirect/mcp/install");
    // VS Code's one-click install goes to user settings, where ${workspaceFolder} is undefined and would stop the server.
    expect(JSON.parse(vscode.searchParams.get("config") ?? "")).toEqual({ type: "stdio", command: "npx", args: ["-y", PACKAGE], env: { LEMMA_API_URL: ORIGIN } });
    expect(install.vscodeUrl).not.toContain("workspaceFolder");
    expect(install.gooseUrl.startsWith("goose://extension?")).toBe(true);
    const goose = new URLSearchParams(install.gooseUrl.slice("goose://extension?".length));
    expect(goose.get("cmd")).toBe("npx");
    expect(goose.getAll("arg")).toEqual(["-y", PACKAGE]);
    expect(goose.get("id")).toBe("lemma");
  });
});
