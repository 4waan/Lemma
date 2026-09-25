# Lemma Local MCP Bridge

## Purpose and economic role

The bridge is the user-facing MCP server installed beside a coding agent. It injects verified prior work into the agent's workflow while keeping repository access, wallet authority, spending limits, and patch application under local control.

The bridge is what turns a hosted resolution service into a useful agent capability. A plain remote MCP connection would not safely hold the buyer wallet or inspect local compatibility.

## Responsibilities

- Run as a local stdio MCP server.
- Read an allowlisted repository profile from the configured workspace.
- Expose preview, purchase, apply, and verification tools.
- Connect to the hosted MCP endpoint as an x402-capable client.
- Enforce per-resolution and daily spending limits before signing.
- Verify resolution signatures and payload digests.
- Preview or atomically apply safe patch bundles.
- Run catalog-pinned acceptance recipes under limits.
- Sign Adoption Receipts with the buyer wallet.
- Activate onchain warranty vouchers and recover interrupted purchases.

## Outside this boundary

- Deciding that an unsupported profile is compatible.
- Sending arbitrary source files to the server.
- Accepting payment instructions from untrusted prose.
- Executing shell strings supplied by a Capability Release.
- Holding provider, facilitator, evaluator, or deployer keys.

## MCP tools

Implemented:

- `lemma_preview({ capability, package? })`
  - It scans the workspace and asks the server for a free preview.
  - It checks drift locally against the release's base probe before any purchase. Local files are hashed here, and none are sent. Probe paths must be safe relative paths (core `PatchPath`), and a file larger than a patch may carry counts as drift without being read.
  - `package` names the package directory in a monorepo (for example `apps/api`). It must be a plain relative path to a real directory with its own `package.json`: links, parent segments and dotfiles are refused, and a missing package is reported rather than replaced by a parent package.
  - Every server request gives up after 10 seconds, so a stalled server ends in the "build it yourself" answer.

- `lemma_apply_resolution({ capability, package?, mode? })` works on the purchase this machine made for the capability that is for this package:
  - a purchase for this package still settling comes first: it is recovered now, and while it settles the answer is to wait, never an older purchase or another package's;
  - else the newest one for this package: bought from a preview of it, or chosen for it before by apply or verify. It is the same package when the `package.json` name matches (or both have none) and so does the directory, or, once the recorded directory is gone (a moved repository), the path in the workspace;
  - else the newest one bought for the package's current repository profile (a second worktree, a sibling package with the same profile), which is what the preview's "already bought" answer matches on.

  The package must still fit the profile the purchase was made for (the catalog's `checkReleaseProfile`, less expiry): otherwise the answer names what no longer fits, and nothing is applied or recorded. The purchase chosen is remembered for the package, so a later change to its profile (a merge, an install) keeps it, one purchase can serve several packages, and a preview offers no second purchase of a release the package already owns. A release manifest the bridge has not stored is fetched by digest (and checked). When that needs the server and it cannot be reached, the answer says so rather than falling back to an older purchase; a purchase whose manifest the server no longer has is left out.
  - `mode: "preview"` (the default) reports what would change: files to add, modify and delete, and dependency changes. Nothing is written.
  - When the package differs from the bundle's base (core `planApply` drift, or a link anywhere on a bundle path), the answer is `adapt`: nothing is written, and the resolution's files are exported to `<state>/export/<resolutionId>/` for the agent to merge by hand, then verify with `adapted: true`. A package whose files already hold exactly the resolution's content answers "already applied", whoever wrote them.
  - `mode: "apply"` applies all or nothing, through one journal per repository (the directory holding the package's lockfile, the monorepo root when there is one), since every install there changes the same manifests:
    - The journal is taken before anything is planned: built under a temporary name with its owner inside, then renamed into place, which fails if another apply in the repository holds it (the answer is to wait). A journal an earlier apply left unfinished is undone first; if that changed the workspace, or could not finish, the answer says what it did and nothing new is written. The plan is then checked with the journal held.
    - The journal records every path, a copy and digest of every file it replaces or deletes, and every directory it creates. Copies and journal are flushed to disk before anything in the workspace changes. New content is staged and flushed; an added file is linked into place, which fails if something appeared there, and a replaced or deleted file must still hold what the bundle was built against, or the apply stops before touching it.
    - Dependency changes are installed with lifecycle scripts disabled (`--ignore-scripts` for npm, pnpm and classic yarn, `--mode=skip-build` and `YARN_ENABLE_SCRIPTS=false` for yarn berry, `--ignore-pnpmfile` for pnpm), exact pins saved exactly, after package.json and every lockfile present are copied into the journal. Installs get the bridge's environment without wallet secrets (the names listed under verify) or the bridge's settings (`LEMMA_*`, `CURSOR_API_KEY`, `*RPC_URL`); everything else passes, since registry configuration often reads tokens from other variables. Installs are killed when the bridge exits or is stopped by a signal; after a crash, the next start kills a verified one before undoing its apply.
    - Any failure rolls everything back, and a journal left by a crash is rolled back when the bridge next starts. The recorded install is killed first, but only when its leader is verified to be the same process. An install that cannot be verified, or a group whose leader is gone (its members cannot be told from another program's), is left alone, and the journal is kept rather than undone under it.
    - A process is recognized by pid and start time, read from `/proc` on Linux, else from `ps` in UTC and the C locale so that bridges in different time zones agree, and only within the pid and time namespaces and the boot they were read in. One from another boot is gone. One from other namespaces (a container or sandbox sharing the state directory) counts as running while the apply refreshes its owner file, every 10 seconds, and as gone a minute after that stops; its install counts as ended 15 minutes after. Start times read in different ways are never compared: such an owner counts as running.
    - A journal whose owner is gone is claimed in place: a `claim.<n>` directory holding the recoverer's identity is renamed into it, which fails if another bridge took that number, and the holders are checked again with the claim in place. The journal is never moved, so a running apply is never disturbed, and its name stays taken until the rollback is done.
    - A rollback restores a bundle file only if it still holds what apply wrote: a file changed since is left as it is, with the original of a file it had replaced kept in `<state>/recovered/`. Restores go through a temporary file with a fixed name per path, removed first on every run, so a crash never leaves one behind.
    - package.json and the lockfiles are put back to their state before the install, since an interrupted install leaves them half changed. What they held is kept in `<state>/recovered/`, because a rollback cannot tell an install's change from an edit made after a crash; each put-back is saved in the journal at once, so a rollback run again after a crash still reports it. A failed install can leave `node_modules` partly changed; the next install puts it right.
    - The answer, and the startup message after a crash, count files left as they are apart from manifests put back.
    - A journal it cannot fully undo is kept and reported, never stopping the bridge. It then lists only the steps that failed, so a retry never repeats one that was done. The next apply in the repository retries it first.
- `lemma_verify_adoption({ capability, package?, adapted? })` runs the release's acceptance recipe (core `acceptanceArgv`) only when a run is evidence about the resolution, and records a receipt only for a run that started. Nothing runs, and nothing is recorded, when:
  - the resolution is not in place here (each file it writes holding exactly its content, each file it deletes gone), unless apply answered `adapt` here and the agent passes `adapted: true` after merging it by hand;
  - an apply is running, or unfinished, in the repository;
  - the package no longer fits the profile the purchase was made for;
  - the package pins a Node major other than the one the bridge runs, which is the Node the tests get;
  - the package has no script by the recipe's name, or only the placeholder `npm init` writes;
  - the package manager is missing, or does not run in the acceptance environment (`<manager> --version`, within 20 seconds).
  - The recipe's manifest is fetched by digest (`GET /api/v1/releases/:digest`) and its digest checked here, then kept in the state directory.
  - The command runs without a shell, in its own process group, with the package manager by the absolute path found on the bridge's PATH. Its environment is only `PATH` (the bridge's Node, the package manager's own directory, then the system directories), a fresh temporary `HOME`, `COREPACK_HOME` and `COREPACK_ENABLE_NETWORK` (below), and the variables the recipe lists. It stops at the recipe's timeout, and whatever it leaves running is killed. Its duration is measured on the monotonic clock. Output is capped at 1 MB and only digested; it never reaches the model.
  - `COREPACK_HOME` points at the user's corepack cache (its own setting, else corepack's default under the user's cache directory), with `COREPACK_ENABLE_NETWORK=0`. So a corepack shim runs a package manager version the user already has and never downloads one; running `<manager> --version` once in the package fetches it. The tests can write to that cache. A version manager's shim that needs the user's HOME (Volta, asdf, mise) does not run with a fresh one: put a real package manager on the bridge's PATH.
  - The network stays reachable by default. On Linux, `LEMMA_ACCEPTANCE_OFFLINE=1` runs the tests in a new network namespace (`unshare --map-root-user --net`, with `unshare`, `sh` and `ip` by absolute path), with loopback brought up by `ip` and checked first by a connection over 127.0.0.1. The wrapper reports on a private descriptor when loopback is up and when the tests start. A failure of the namespace, of loopback or of the command lookup therefore counts as not started, never as a failed test. Where offline mode is unavailable, nothing runs and nothing is recorded. The tests then run as root mapped to the user, which some tools refuse (the Chromium sandbox, for example).
  - The tests run as the user and can read what the user can, including the bridge's start environment in `/proc`. Verify therefore refuses to run while the bridge's environment, or the one it started with, holds a wallet secret: a name (any case) matching `PRIVATE_?KEY`, `PRIVKEY`, `SIGNING_?KEY`, `MNEMONIC`, `SEED_?PHRASE` or `RECOVERY_?PHRASE`, or `WALLET`, `SIGNER`, `BUYER` or `DEPLOYER` followed by `KEY`, `SECRET`, `PASS`, `PASSWORD`, `PASSPHRASE`, `PRIVATE`, `SEED` or `PK` (`WALLET_SECRET` in `secrets.ts`). Installs never get these names either. A key file the user can read is readable by the tests too, so a wallet key should live with a signer that runs as another user, or on a hardware or remote signer.
  - The receipt is signed by the payment work's hook when one is registered. When the hook fails, the receipt is kept and never sent unsigned (the first write wins on the server), and it is signed at the next verify. Without a hook it is sent unsigned, and the server keeps it unverified. It is posted with the preview id, which proves the sender is the buyer.
  - The first run's receipt is the one that counts. `NOT_SETTLED` and `TOO_EARLY` answers, and receipts the server could not be reached for, are sent again at the next start; `UNKNOWN_RESOLUTION` and `MISMATCH` are final and reported. A later verify only retries sending (or signing) the first run's receipt, and every answer it gives names that receipt's outcome and says this run is not recorded.

Registered by the payment work through `createBridgeServer`'s registrar:

- `lemma_buy_resolution` (payment work): it reads the open offer with `latestOffer`, marks the purchase pending with `inbox.markPending(previewId, buyer, now, releaseDigest)`, and stores the delivery with `inbox.put`. After a lost or failed paid response it must call `ctx.recover()`, never pay again. `latestOffer` gives an offer only while the last preview for that capability succeeded, found no drift and has not expired (by the monotonic or the wall clock), and while no purchase of that release is pending or stored.

The tools declare no `outputSchema` and answer in at most 600 characters built from enums, numbers, codes, bundle paths and at most a short plain test script name. Bundle paths are chosen by the release: they are validated segments (core `PatchPath`), and an answer shows one only when it is at most 100 characters with segments of at most 40, and at most 120 characters of paths in all, counting the rest. So beyond a few short file names, no catalog text reaches the model. Tool definitions plus instructions stay under 3,000 characters. A test enforces both limits, because every character is in the agent's context on every turn.

Recovery runs automatically:

- A purchase is marked pending before the paid call.
- At startup, and whenever the paid tool calls `ctx.recover()`, the bridge calls the server's free `lemma_recover_resolution` for each pending mark.
- A mark the server never saw is dropped after 15 minutes, once no authorization could still settle.

## Repository profile

`scanWorkspace` builds the privacy-safe profile:

- **Package.** The nearest `package.json` at or above the working directory, or the named package.
- **Lockfile.** The nearest lockfile at or above the package, which covers npm, pnpm and yarn workspaces. `npm-shrinkwrap.json` wins over `package-lock.json`, as in npm. When `packageManager` names a manager, only its lockfile is read. If that lockfile is absent, or several managers' lockfiles are present and `packageManager` does not choose, no version is resolved and that is noted.
- **Dependencies.** Declared dependencies and devDependencies in the catalog's interest set for the capability, each at the exact version the lockfile installed. Only registry ranges are looked up: `npm:` aliases and git, file, link and workspace specifiers are left out, and so is a locked version outside the declared range.

  | Lockfile | How the version is found |
  | --- | --- |
  | npm v2 and v3 | `packages["<rel>/node_modules/<name>"]`, walking up like Node's resolution, only for a package the lockfile records; aliased, git and file entries give nothing (v1: the root's `dependencies` tree only) |
  | pnpm v5.4, v6 and v9 | a line scan of the importer's block under `importers:`, or of the top-level blocks of a single-project lockfile, without peer suffixes |
  | yarn classic and berry | the block whose header names the declared specifier |

  No YAML parser is used. Anything unresolved is left out and noted, never guessed.
- **Other fields.** The Node major comes from `.nvmrc` or `.node-version` (a version or an LTS codename such as `lts/iron`), else the running Node, noted. A pin that names no major (`lts/*`, `node`) is noted as incomplete. The module system comes from `type`, and the language from `tsconfig.json` or a `typescript` dependency. Frameworks come from declared dependencies.

The scanner reads only allowlisted file names, capped at 32 MB each. It refuses symlinks on every path segment, including a linked package directory or lockfile, and anything outside the workspace. A workspace root reached through a link is resolved to its real path at startup. Results are cached until a scanned file's size or modification time changes.

## The Lemma rule

`rules/lemma.mdc` (under 600 characters) tells an agent to call `lemma_preview` before building an x402 integration. `lemma-mcp install-rule [dir]` writes it to `<dir>/.cursor/rules/lemma.mdc` without following links. The benchmark's treatment arm receives exactly this file.

## Workspace dependencies

- `@lemma/core` for shared schemas and digests.
- The MCP SDK for the local stdio server and hosted client.
- x402 packages for payment creation and response handling.
- viem for buyer signing and warranty activation.

## Environment variables

The bridge uses `LEMMA_API_URL` (default `http://localhost:3000`), `LEMMA_WORKSPACE` (default: the working directory) and `LEMMA_STATE_DIR` (default `$XDG_STATE_HOME/lemma`, else `~/.local/state/lemma`, where the resolution inbox, release manifests, receipts, apply journals and exports live, private to the user). An empty value counts as unset; a relative one, or one inside the workspace, stops the bridge at startup. `LEMMA_ACCEPTANCE_OFFLINE=1` runs acceptance tests without network on Linux. `LEMMA_BRIDGE_TRACE` is for the benchmark harness only: it appends one line per initialize and tool call, including calls rejected for their arguments, with the tool name (or `other`) and nothing else.

The payment work adds `ARBITRUM_SEPOLIA_RPC_URL`, `LEMMA_MAX_USDC_PER_RESOLUTION`, `LEMMA_DAILY_USDC_CAP`, `USDC_ADDRESS`, the registry address, and the buyer key.

The buyer key must stay inside the bridge process. It must never appear in MCP content, model context, logs, receipts, or remote requests, and not in the bridge's environment either: acceptance tests and installs run as descendants, which can read the bridge's start environment from `/proc`. A file only the user can read does not protect it either, since the tests run as that user: keep it in a signer process that runs as another user, or on a hardware or remote signer. Verify refuses to run tests while a wallet key is in the environment.

## Development and tests

- `npm run dev -w @lemma/bridge`
- `npm run build -w @lemma/bridge`
- `npm run test -w @lemma/bridge`

The compiled package exposes the `lemma-mcp` executable (`dist/main.js`). The tests drive the bridge through a real MCP client against the real server app in-process. They count requests (one per preview once warm) and enforce the context budgets.

## Security constraints

- Canonicalize every filesystem path and keep it inside the workspace root.
- Reject symlinks, absolute paths, parent traversal, protected files, and binary mutations.
- Read only reviewed manifest and lockfile names during profile creation.
- Validate network, token, recipient, amount, expiry, and local budgets before signing.
- Apply patches atomically and fail on base-file drift.
- Spawn acceptance commands without a shell, with an allowlisted environment, timeout, and output limit, after checking the package manager runs.
- Scrub all sensitive values from errors and receipts.

## Later completion criteria

This component is complete when a supported coding agent can install it, receive a free preview, make one policy-compliant testnet purchase, recover it after an injected connection failure, preview and apply the signed patch, run the acceptance recipe, and submit a signed receipt without exposing repository source or keys.
