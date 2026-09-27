# Vendored Claude Code skills: sources, licenses, vetting

Everything under `.claude/skills/` except this file is third-party content, copied from the
upstream commits below. The first five skills were vetted on 2026-09-24; the three Trail of Bits
smart-contract skills (`token-integration-analyzer`, `guidelines-advisor`,
`secure-workflow-guide`) were vetted on 2026-09-27. Each skill directory carries its upstream
license file. Two files were modified during vetting (see "Modifications"); every other file is
byte-identical to upstream at the pinned commit.

## Inventory

| Skill | Upstream repo | Pinned commit | Upstream path | License | Files included | Files omitted and why | Scanner result |
|---|---|---|---|---|---|---|---|
| `mcp-builder` | [anthropics/skills](https://github.com/anthropics/skills) | `33375500bcea98d610eb30ce10ac4e59b89c390d` | `skills/mcp-builder` | Apache-2.0 (`LICENSE.txt`, from the skill directory) | `SKILL.md`, `LICENSE.txt`, `reference/evaluation.md`, `reference/mcp_best_practices.md`, `reference/node_mcp_server.md`, `reference/python_mcp_server.md` (6 files) | `scripts/evaluation.py`, `scripts/connections.py`, `scripts/example_evaluation.xml`, `scripts/requirements.txt`: the evaluation harness needs `ANTHROPIC_API_KEY`, pip-installs `anthropic` and `mcp`, and defaults to the retired model `claude-3-7-sonnet-20250219`. `SKILL.md` (Phase 4 list) and the "Running Evaluations" section of `reference/evaluation.md` still describe these scripts; they are not present here, so treat that section as not applicable. | 0 findings |
| `build-mcp-server` | [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | `e225b998a17e06ac87787165f2a1b5c1cac7edc2` | `plugins/mcp-server-dev/skills/build-mcp-server` | Apache-2.0 (`LICENSE`, copied from `plugins/mcp-server-dev/LICENSE`) | `SKILL.md`, `LICENSE`, `references/{auth,deploy-cloudflare-workers,elicitation,remote-http-scaffold,resources-and-prompts,server-capabilities,tool-design,versions}.md` (10 files) | Nothing omitted from the skill directory. The sibling skills `build-mcp-app` and `build-mcpb` (same plugin) were not requested, so hand-offs to them in `SKILL.md`, and citations of `build-mcpb/references/local-security.md` in `tool-design.md` and `server-capabilities.md`, point at skills that are not installed. | 0 findings |
| `hono` | [honojs/skills](https://github.com/honojs/skills) | `8b1938be37331c68a02c3b75896b2ea3839d7d09` | `skills/hono` | MIT (`LICENSE`, copied from repo root, Copyright (c) 2026 Yusuke Wada) | `SKILL.md` (**modified**), `LICENSE` (2 files) | The "Hono CLI" section of `SKILL.md` (29 lines) was **stripped**; see "Modifications". The sibling skill `hono-jsx` was not requested; the JSX section's pointer to it dangles. | 0 findings (before and after the edit) |
| `property-based-testing` | [trailofbits/skills](https://github.com/trailofbits/skills) | `32e34f8173796e3566a51aee877dc96bc5191f64` | `plugins/property-based-testing/skills/property-based-testing` | CC-BY-SA-4.0 (`LICENSE`, copied from repo root) | `SKILL.md`, `LICENSE`, `references/{generating,interpreting-failures,libraries,refactoring,reviewing}.md` (7 files) | `README.md` (maintainer notes on design history and eval results, not agent instructions); `agents/openai.yaml` (OpenAI/Codex UI metadata); `assets/trail-of-bits-mark.svg` (logo referenced only by `openai.yaml`); plugin-level `evals/` and `evals-extra/` (eval fixtures). Only `SKILL.md` and its reference docs were in scope. | 0 findings |
| `gha-security-review` | [getsentry/skills](https://github.com/getsentry/skills) | `c2f99a5b04b4cd992ec3022d7c2c3e23e938d241` | `skills/gha-security-review` | Apache-2.0 (`LICENSE`, copied from repo root, Copyright 2025 Functional Software, Inc. dba Sentry) | `SKILL.md` (**modified**), `LICENSE`, `references/{ai-prompt-injection-via-ci,comment-triggered-commands,credential-escalation,expression-injection,permissions-and-secrets,pwn-request,real-world-attacks,runner-infrastructure,supply-chain}.md` (11 files) | Nothing omitted. `Bash` was **removed from `allowed-tools`**; see "Modifications". | 0 findings (before and after the edit) |
| `token-integration-analyzer` | [trailofbits/skills](https://github.com/trailofbits/skills) | `0cc1c73a5e96749ab32d7ea5e14892fafa6972ae` | `plugins/building-secure-contracts/skills/token-integration-analyzer` | CC-BY-SA-4.0 (`LICENSE`, copied from repo root) | `SKILL.md`, `LICENSE`, `resources/{ASSESSMENT_CATEGORIES,REPORT_TEMPLATES}.md` (4 files) | `agents/openai.yaml` (OpenAI/Codex UI metadata: display name, short description, icon and brand colour, not agent guidance); `assets/trail-of-bits-mark.svg` (logo referenced only by `openai.yaml`; it holds no script, event handler or link). The plugin's `README.md` and `.claude-plugin/plugin.json` sit outside the skill directory (catalogue notes and plugin metadata). Only `SKILL.md` and its reference docs were in scope; the `resources/` folder keeps its upstream name so the links in `SKILL.md` resolve. | 0 findings (upstream and installed); the scanner does not read `resources/`, see below |
| `guidelines-advisor` | [trailofbits/skills](https://github.com/trailofbits/skills) | `0cc1c73a5e96749ab32d7ea5e14892fafa6972ae` | `plugins/building-secure-contracts/skills/guidelines-advisor` | CC-BY-SA-4.0 (`LICENSE`, copied from repo root) | `SKILL.md`, `LICENSE`, `resources/{ASSESSMENT_AREAS,DELIVERABLES,EXAMPLE_REPORT}.md` (5 files) | `agents/openai.yaml` and `assets/trail-of-bits-mark.svg`, for the same reasons as `token-integration-analyzer`. | 0 findings (upstream and installed); the scanner does not read `resources/`, see below |
| `secure-workflow-guide` | [trailofbits/skills](https://github.com/trailofbits/skills) | `0cc1c73a5e96749ab32d7ea5e14892fafa6972ae` | `plugins/building-secure-contracts/skills/secure-workflow-guide` | CC-BY-SA-4.0 (`LICENSE`, copied from repo root) | `SKILL.md`, `LICENSE`, `resources/{EXAMPLE_REPORT,WORKFLOW_STEPS}.md` (4 files) | `agents/openai.yaml` and `assets/trail-of-bits-mark.svg`, for the same reasons as `token-integration-analyzer`. Its Step 2 hands token work to `token-integration-analyzer`, which is installed; none of the three points at a sibling skill that is missing. | 0 findings (upstream and installed); one URL outside the scanner's trusted list (`meetings.hubspot.com`, Trail of Bits office hours), which is not a finding |

"Scanner result" is the output of `scripts/scan_skill.py` from
[getsentry/skills `skills/skill-scanner`](https://github.com/getsentry/skills/tree/c2f99a5b04b4cd992ec3022d7c2c3e23e938d241/skills/skill-scanner)
at the same pinned commit. It was run with `uv run` against each upstream skill directory and
again against the final copies in this folder. The skill-scanner itself is **not** installed here.

That script only reads `SKILL.md`, `references/*.md` and `scripts/*`, so it would miss
`mcp-builder/reference/` (singular), the `resources/` folders of the three Trail of Bits
smart-contract skills (their reference docs: 7 of their 10 Markdown files), `LICENSE` files and
the omitted extras. A second pass therefore applied the scanner's own prompt-injection,
obfuscation, secret and dangerous-code checks to **every** file, and added checks for
`` !`cmd` `` load-time commands, `allowed-tools`, and `curl | sh` pipes. For the three
smart-contract skills it ran over every upstream file (including the omitted `agents/openai.yaml`
and logo) and again over the installed copies, after a positive control confirmed that it flags
each of those patterns. That pass found no hits outside `gha-security-review/references/`. Its 13
`curl ... | bash` hits there are documented attack payloads inside code blocks labelled
`VULNERABLE` or "Attacker's …", which describe threats for the reviewer to recognise; nothing
tells the agent to run them.

Structural checks across all installed files found none of the following: symlinks, scripts,
`package.json`, test files, frontmatter `hooks`, `` !`cmd` `` lines, zero-width, bidi or
Unicode-tag characters, or real credentials. Every `SKILL.md` has YAML frontmatter that
`yaml.safe_load` parses, with a string `name` equal to the directory name and a non-empty
`description`. The only non-ASCII characters in the three smart-contract skills are check marks,
crosses, warning signs, ballot boxes, box-drawing lines, arrows, `≠`, one `🎯` emoji and the
curly quotes of the license text. `gitleaks dir --no-banner --redact --config .gitleaks.toml
.claude/skills` reported no leaks on 2026-09-27.

## Modifications

Both changes remove behaviour. They add nothing new and change no guidance. The three
smart-contract skills (`token-integration-analyzer`, `guidelines-advisor`,
`secure-workflow-guide`) are **unmodified**: vetting found nothing that had to be removed.

1. **`hono/SKILL.md`** (MIT)
   - Removed the entire `## Hono CLI` section. It told the agent to run
     `npm install -D @hono/cli@next` (an unpinned prerelease dist-tag, added as a project
     dependency, which conflicts with this repo's exact-version pins), then
     `npx hono agent-context`, then to "Follow the output". That is fetching and executing
     remote code and treating its output as instructions. The skill's trigger fires on every
     `hono` import, so it would have applied across the whole server. The section's follow-on
     notes (`npx hono request|batch|snapshot`) went with it, because `npx` downloads a package
     when the CLI is not installed locally.
   - Dropped the sentence "Use Hono CLI to inspect and test the app." from the frontmatter
     `description` and from the intro paragraph.
   - Added a short blockquote in place of the section that states the change and points to the
     existing "Testing with app.request()" section. The removed text is reproducible from the
     pinned commit.
2. **`gha-security-review/SKILL.md`** (Apache-2.0)
   - `allowed-tools: Read, Grep, Glob, Bash, Task` became `allowed-tools: Read, Grep, Glob, Task`.
     Unscoped `Bash` would pre-approve any shell command while the skill is active, and the
     skill body never needs a shell (its grep recipes can run through the Grep tool, or under
     a normal Bash permission prompt). `Task` was kept: it launches subagents, whose own tool
     calls still go through the normal permission checks.
   - Added an HTML-comment change notice under the frontmatter, as Apache-2.0 §4(b) requires.

## Reviewed and kept (worth knowing, not stripped)

None of these is pre-approved. After vetting, no installed skill pre-approves Bash, WebFetch or
network access, so Claude Code's normal permission prompts apply to each one.

- **Remote docs loaded as guidance (unpinned):** `mcp-builder` tells the agent to WebFetch the
  MCP SDK READMEs from `raw.githubusercontent.com/.../main/README.md` and to read
  `modelcontextprotocol.io` pages. `build-mcp-server` tells it to fetch
  `https://claude.com/docs/llms-full.txt` before advising. `hono` points to `hono.dev/llms.txt`
  and `curl -H "Accept: text/markdown"` doc pages. These are first-party docs to read; nothing is
  executed.
- **Package-manager commands the user or agent may run:** `npx @modelcontextprotocol/inspector`
  (`mcp-builder`, `build-mcp-server`); `npm create cloudflare@latest` with the unpinned template
  `cloudflare/ai/demos/remote-mcp-authless`, plus `npx wrangler dev|deploy|secret put`
  (`build-mcp-server/references/deploy-cloudflare-workers.md`); `pip install fastmcp`;
  `npm run cf-typegen` / `npx wrangler types` (`hono`, only for Workers projects, which Lemma is
  not). Prefer the repo's pinned toolchain over these.
- **Placeholders only, not credentials:** `your_api_key_here`, `abc123`, `token123`, `ghp_xxx`
  (`mcp-builder/reference/evaluation.md`); `basicAuth({ username: 'admin', password: 'secret' })`
  (`hono`); `Authorization: Bearer ...` (`build-mcp-server`).
- **Content caveats for Lemma:** the `mcp-builder` TypeScript guide targets Zod 3 (`zod ^3.23.8`,
  `z.nativeEnum`) and Express. Lemma uses Zod 4 and Hono, so adapt the examples rather than
  copying them. The `build-mcp-server` FastMCP scaffold binds `0.0.0.0`; its own checklist
  requires `Origin` validation.
- `property-based-testing` frontmatter carries `effort: low` (an upstream hint, not a permission).
  `build-mcp-server` carries `version: 0.1.0`.
- **Local analysis commands in the smart-contract skills:** all three describe running the
  Slither suite (`slither . --exclude-dependencies`; `slither --print` with `human-summary`,
  `contract-summary`, `inheritance-graph`, `function-summary` or `vars-and-auth`;
  `slither-check-erc`, `slither-check-upgradeability`, `slither-prop`). These read local sources
  only, and each one still needs a Bash permission prompt. The `secure-workflow-guide`
  rationalization table says "Install and run Slither, or document why it's blocked": use an
  already installed, version-pinned Slither rather than an ad hoc unpinned install.
- **Testing tools the skills suggest:** `secure-workflow-guide` Step 4 sets up Echidna and
  Manticore. Manticore's latest PyPI release is 0.3.7 from 2022-02-17 (checked 2026-09-27). For
  Lemma's Foundry project, prefer Foundry fuzz and invariant tests, and Echidna or Medusa as the
  `property-based-testing` skill describes.
- **On-chain queries:** `token-integration-analyzer` (Phase 4 and "On-chain Analysis Integration"
  in `resources/ASSESSMENT_CATEGORIES.md`) queries a deployed token with web3.js
  (`new Web3('RPC_URL')`), and only when the user supplies an address and an RPC endpoint. In
  Lemma use viem, the repo's EVM library, and read the RPC URL from the environment: a provider
  RPC URL often carries an API key in its path, so it must never go into a prompt, a
  command-line argument or a committed file (the `rpc-endpoint-with-key` gitleaks rule).
- **External links, read-only:** `secure-workflow-guide` ends with "Getting Help", linking Trail
  of Bits office hours (`meetings.hubspot.com`) and naming the Empire Hacking Slack. The plugin
  `README.md`, which is not installed, also carries a Slack invite link. Nothing tells the agent
  to fetch or join them.
- **Example reports are fictional samples:** the `EXAMPLE_REPORT.md` and `SKILL.md` examples
  (a "MultiToken DEX", an "NFT Marketplace", a "DeFi Staking Contract", dated March 15, 2024) show
  the output format only. They use placeholders (`security@project.com`, truncated addresses such
  as `0x1234...` and `0xdac17f9...`, an Echidna `deployer: "0x10000"`) and say nothing about
  Lemma. Their versions (`@openzeppelin/contracts@4.9.0`, Solidity 0.8.19 and 0.8.20) are older
  than the ones Lemma pins; follow `contracts/foundry.toml` (solc 0.8.30) and the dependencies
  pinned under `contracts/lib`. The token checklist's USDC facts (upgradeable, blocklist,
  pausable, 6 decimals) do apply to the USDC that Lemma settles in.

## License and attribution notes

- **Apache-2.0** (`mcp-builder`, `build-mcp-server`, `gha-security-review`): the license text
  ships in each directory. None of the three pinned upstream paths has a `NOTICE` file. Keep the
  §4(b) change notice in any modified file.
- **MIT** (`hono`): keep `hono/LICENSE` with its copyright notice.
- **CC-BY-SA-4.0** (`property-based-testing`): "Property-Based Testing" skill by Henrik Brodin,
  Trail of Bits (`opensource@trailofbits.com`), from
  <https://github.com/trailofbits/skills/tree/32e34f8173796e3566a51aee877dc96bc5191f64/plugins/property-based-testing/skills/property-based-testing>,
  licensed under CC BY-SA 4.0 (<https://creativecommons.org/licenses/by-sa/4.0/>). It is included
  **unmodified**. This content must keep this attribution and ship with its `LICENSE`. If any of
  it is modified, the change must be indicated and the modified version must stay under
  CC BY-SA 4.0 (ShareAlike). Do not relicense it under the repo's own license. Its installed
  files are also byte-identical at `0cc1c73`, the commit the smart-contract skills are pinned to
  (checked 2026-09-27), so the two Trail of Bits pins differ in commit only, not in content.
- **CC-BY-SA-4.0** (`token-integration-analyzer`, `guidelines-advisor`, `secure-workflow-guide`):
  the "Token Integration Analyzer", "Guidelines Advisor" and "Secure Workflow Guide" skills of the
  `building-secure-contracts` plugin (version 1.2.2) by Omar Inuwa and Paweł Płatek, Trail of
  Bits (`opensource@trailofbits.com`), as named in the plugin's `.claude-plugin/plugin.json`,
  from
  <https://github.com/trailofbits/skills/tree/0cc1c73a5e96749ab32d7ea5e14892fafa6972ae/plugins/building-secure-contracts/skills>
  (subdirectories `token-integration-analyzer`, `guidelines-advisor` and
  `secure-workflow-guide`), licensed under CC BY-SA 4.0
  (<https://creativecommons.org/licenses/by-sa/4.0/>). The plugin builds on Trail of Bits'
  [Building Secure Contracts](https://github.com/crytic/building-secure-contracts). All three are
  included **unmodified**, each with the repository's `LICENSE`. The same obligations apply: keep
  this attribution, indicate any change in the file and under "Modifications", keep modified
  versions under CC BY-SA 4.0, and never relicense them under the repo's own license.

## Updating a skill

Fetch the new commit into a scratch directory, not into the repo. Run
`uv run skills/skill-scanner/scripts/scan_skill.py <skill-dir>` from a checkout of
getsentry/skills, then read every changed file. The scanner skips any folder other than
`references/` and `scripts/` (such as `reference/` or `resources/`), so repeat the second pass
above over every file. Reapply the two modifications above if they still apply, update the
commit and file list in the table, and run
`gitleaks dir --no-banner --config .gitleaks.toml .claude/skills` before committing.
