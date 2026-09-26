# Bridge Runtime

The local bridge is Lemma's authority boundary for repository access, buyer state, patch application, and acceptance evidence. This document records the mechanics that are too detailed for the component README.

## Repository profiling

The bridge finds a real package directory, reads an allowlisted set of manifests and lockfiles, and builds a typed `RepositoryProfile`. It does not send repository source, internal package names outside the catalog interest set, environment files, Git internals, or credentials.

Monorepo package selection is explicit. Parent traversal, dotfile segments, symbolic links, and directories without their own `package.json` are rejected.

Before a purchase, the bridge fetches the release's base probe and hashes the relevant local files. A changed, missing, oversized, linked, or unexpected path is reported as drift without uploading its contents.

## Resolution selection

Apply and verify select the newest applicable purchase for the requested capability and package. A still-settling purchase takes priority and is recovered first. A purchase already associated with the package remains associated after a merge or dependency install, provided the package still fits the release profile.

The bridge stores manifests by digest. If a required manifest is missing locally, it fetches and validates the immutable server copy rather than trusting an older purchase.

## Preview, adapt, and apply

Preview mode reports file additions, modifications, deletions, and dependency changes without writing.

If the repository differs from the bundle's base, the bridge returns `adapt`. It exports the purchased resolution into bridge state for the agent to merge manually. Verification then requires an explicit `adapted: true` signal.

Apply mode is all-or-nothing. One journal is allowed per lockfile-owning repository, so two packages cannot run competing dependency installs against the same manifests.

## Crash-safe journal

The journal records its owner, every affected path, original file copies and digests, directories created by the apply, and the dependency-install process identity. Journal data and staged content are flushed before the workspace changes.

An added file is linked into place only if the path is still empty. A modified or deleted file must still match its expected base. Any failure begins rollback.

On startup and before a new apply, the bridge inspects unfinished journals. It first handles any recorded install, then claims an abandoned journal without moving it, and resumes rollback. Live ownership is identified by process id, start time, boot, namespace information, and a heartbeat when direct comparison is unsafe.

Rollback restores a file only when it still contains what Lemma wrote. A file changed afterward is kept, and any displaced original is preserved under the recovery directory. Manifest and lockfile recovery is recorded step by step so another crash can resume it safely.

## Dependency installation

Dependency changes are declarations, not edits to manifests or lockfiles in the bundle. The bridge saves exact versions and disables package lifecycle scripts for npm, pnpm, Yarn Classic, and Yarn Berry.

Wallet secrets, Lemma settings, Cursor credentials, and RPC variables are removed from the install environment. Registry credentials with unrelated names remain available because package managers may require them.

An install that survives its bridge is killed only when the process identity can be verified. Ambiguous processes are left running and the journal remains blocked for operator review.

## Acceptance runs

Verification runs only when the resolution is present, no apply journal is active, the package still fits the purchased profile, the package manager is available, and the configured script is real.

The acceptance command runs without a shell, in its own process group, with a fresh home directory, bounded output, and a timeout. Raw output never enters model context. The receipt records the digest and execution result.

The bridge refuses to start an acceptance run when its current or startup environment contains a wallet-secret variable. Files readable by the operating-system user remain readable by the test process, so production buyer signing should use another user, hardware signer, or remote signer.

On Linux, optional offline mode creates a new network namespace with loopback enabled. If namespace setup cannot be verified, no test starts and no receipt is recorded.

## Receipt delivery

The first started acceptance run creates the receipt that counts. Retryable server responses and network failures are retried later. Final mismatches are retained and reported.

A registered payment hook signs the receipt. If signing fails, the bridge keeps it and never submits it unsigned. Without a payment hook, the current development path can submit an unsigned receipt, which the server stores as unverified.
