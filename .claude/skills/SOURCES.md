# Vendored Claude Code skills: sources, licenses, vetting

Everything under `.claude/skills/` except this file is third-party content, copied from the
upstream commits below and vetted on 2026-09-24. Each skill directory carries its upstream
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

"Scanner result" is the output of `scripts/scan_skill.py` from
[getsentry/skills `skills/skill-scanner`](https://github.com/getsentry/skills/tree/c2f99a5b04b4cd992ec3022d7c2c3e23e938d241/skills/skill-scanner)
at the same pinned commit. It was run with `uv run` against each upstream skill directory and
again against the final copies in this folder. The skill-scanner itself is **not** installed here.

That script only reads `SKILL.md`, `references/*.md` and `scripts/*`, so it would miss
`mcp-builder/reference/` (singular), `LICENSE` files and the omitted extras. A second pass
therefore applied the scanner's own prompt-injection, obfuscation, secret and dangerous-code
checks to **every** file, and added checks for `` !`cmd` `` load-time commands, `allowed-tools`,
and `curl | sh` pipes. That pass found no hits outside `gha-security-review/references/`. Its 13
`curl ... | bash` hits there are documented attack payloads inside code blocks labelled
`VULNERABLE` or "Attacker's …", which describe threats for the reviewer to recognise; nothing
tells the agent to run them.

Structural checks across all installed files found none of the following: symlinks, scripts,
`package.json`, test files, frontmatter `hooks`, `` !`cmd` `` lines, zero-width, bidi or
Unicode-tag characters, or real credentials. Every `SKILL.md` has YAML frontmatter that
`yaml.safe_load` parses, with a string `name` equal to the directory name and a non-empty
`description`.

## Modifications

Both changes remove behaviour. They add nothing new and change no guidance.

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
  CC BY-SA 4.0 (ShareAlike). Do not relicense it under the repo's own license.

## Updating a skill

Fetch the new commit into a scratch directory, not into the repo. Run
`uv run skills/skill-scanner/scripts/scan_skill.py <skill-dir>` from a checkout of
getsentry/skills, then read every changed file. Reapply the two modifications above if they
still apply, update the commit and file list in the table, and run
`gitleaks dir --no-banner --config .gitleaks.toml .claude/skills` before committing.
