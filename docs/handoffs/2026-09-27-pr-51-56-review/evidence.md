# Verification evidence for PRs #51 to #56 (collected 2026-09-27)

## Branch structure (from the fetched PR refs)

- Base of every PR: 4waan/Lemma main at 1042344. All six merge cleanly with main (`git merge-tree`, and the API's mergeable state is clean).
- #51 (06c712e) and #56 (5b375a1) branch from e002b5b, the main before #31, #32 and #35 merged; they do not contain those merges. #36 (cd9782e) also branches from e002b5b.
- #52 (1378828) and #53 (9b92151) are both built on top of #36 (cd9782e is an ancestor of both), so their diffs against main include #36's web redesign. #52 has 8 own commits, #53 has 10.
- #54 (e4d7782) starts with merge commit 971d650 (parents: #53 head and #52 head; conflicts resolved in README.md, apps/server/README.md, apps/server/test/dashboard.test.ts, apps/web/README.md, docs/server-runtime.md), then 6 own commits.
- #55 (1d98041) starts with merge commit ea80046 (parents: #54 head and #51 head; conflicts resolved in .env.example, .github/workflows/ci.yml, .gitignore, README.md, SECURITY.md, contracts/README.md, docs/architecture.md, docs/deployment.md, docs/protocol.md, docs/security-model.md, package.json), then 10 own commits.
- contracts/src, contracts/test, contracts/script, contracts/foundry.toml, contracts/abi and .gitmodules are byte-identical between #51 and #55.
- Pairwise merge-tree: #51+#52, #51+#53, #51+#54 and #52+#53 conflict (as the PR bodies warn); #33+#55, #34+#55, #37+#55, #36+#51 and #56+#55 are clean.
- #55 does not contain the merged commits of #31, #32 or #35 (checked by ancestry), as the backlog states.

## Local runs on the #55 worktree (head 1d98041), Node 22.22.2, npm 10.9.7

| Check | Result | PR body claim |
| --- | --- | --- |
| `npm ci` | 205 packages | |
| `npm run verify` | typecheck, test typecheck and build pass; tests: 49 files passed, 1 failed, 3 skipped; 966 tests passed, 1 failed, 16 skipped; 55.8 s | 50 passed, 3 skipped; 968 passed, 15 skipped |
| The one failure | `apps/bridge/test/acceptance.test.ts` "runs offline tools by their paths": `offlineTools("/nonexistent")?.sh` is undefined because this container has no `ip` binary. The same test fails identically on `main` in the primary checkout, and CI (which has `ip`) passes it. Environmental, not a PR defect. Two skipped tests in that file account for the count difference. | |
| `npm run secrets:scan` | 81 commits scanned, no leaks | no leaks |
| `npm run db:generate -w @lemma/server` twice | "No schema changes, nothing to migrate" both times; worktree clean | no schema changes |
| `LEMMA_WRITE_VECTORS=1 npx vitest run packages/core/test/vectors.test.ts` | 14 tests pass; the rewrite is byte-identical; against main, digests.json has 36 added lines and 1 removed (the `baseReleaseDigest` line rewritten with a trailing comma): additions only. New vectors: `payment-nonce`, `acceptance-recipe`. New derived values: paymentNonce, warrantyClaimHash, adoptionReceiptTypedDataHash, acceptanceRecipeDigest, adoptionFeedbackHash, warrantyVoucherTypedDataHash, warrantyOutcomeTypedDataHash | additions only |
| `cargo fmt --all --check`, `cargo clippy --locked --workspace --all-targets -- -D warnings`, `cargo test --locked --workspace` (contracts/stylus, Rust 1.94.1) | clean, clean, 33 tests pass (12 + 2 + 7 + 10 + 2) | 33 passed |
| `node packages/confidence/scripts/build-wasm.mjs --check` | byte-identical: sha256 46a571ad9740cf6d3aaedd6b41bfb30e87f40696d3caf69421950d4ee7eb5512, 29,857 bytes | same sha256 and size |
| `forge fmt --check`, `forge build`, `forge test` (Foundry 1.7.1, solc 0.8.30, FOUNDRY_OFFLINE=true) | clean; 64 files compiled; 117 tests in 14 suites pass (fuzz 9.5 s, invariants 9.6 s) | 117 in 14 suites |
| `npm run contracts:abi -- --check` | 2 committed ABIs match the build | match |
| `npm run contracts:rehearse` | ok; registry deployed on anvil at chain id 421614; record checked and removed; worktree clean afterwards | ok |
| `npm run e2e` | 7 of 7 scenarios pass in 76 s (setup 36 s; pass, refund, damper, crash safety, expiry, no-secret-log) | 7 of 7 in about 71 s |
| `LEMMA_REGISTRY_ARTIFACTS=contracts/out npx vitest run apps/server/test/warranty-anvil.test.ts` | 6 of 6 pass | 6 of 6 |
| `LEMMA_TEST_DATABASE_URL=… npx vitest run apps/server/test/postgres.test.ts` against a local PostgreSQL 16.13 cluster | 5 of 5 pass | CI's postgres job |
| Submodules | forge-std bf647bd (v1.16.2), openzeppelin-contracts 5fd1781 (v5.6.1) | same |
| Timing (backlog items 13 and 27) | `resolve.test.ts` properties "is deterministic and independent of catalog order" 787 ms and "reuses only a profile that passes every check" 621 ms when run alone here; parallel run: see below | backlog: 6.5 to 6.8 s on a busy machine |

## CI on each PR head (all green)

| PR | Run | Jobs |
| --- | --- | --- |
| #51 | 36331526676 | verify 108654278071, contracts 108654277923, postgres 108654278063, gitleaks 108654278140 |
| #52 | 36331562033 | verify 108654375849, contracts 108654375859, stylus 108654375820, postgres 108654375707, gitleaks 108654375860 |
| #53 | 36331639842 | verify 108654586855, contracts 108654586862, postgres 108654586669, gitleaks 108654586879 |
| #54 | 36331701935 | verify 108654760766, contracts 108654761150, stylus 108654760936, postgres 108654760933, gitleaks 108654760857 |
| #55 | 36331757360 | verify 108654915539, contracts 108654915600, stylus 108654915553, e2e 108654915394, postgres 108654915618, gitleaks 108654915488 |
| #56 | 36333830817 | verify 108660754597, contracts 108660754607, postgres 108660754461, gitleaks 108660754553 |

## Backlog (PR #56) cross-checks

- The uploaded backlog is byte-identical to docs/follow-up-backlog.md at the #56 head (blob f21c10a6).
- Items 1 to 13 map to issues #38 to #50 in order (titles match).
- Every repository path the backlog names exists at the #55 head; every npm script it names exists (root, apps/server, apps/bridge).
- The feature PR numbers the backlog calls unknown: #51 registry, #52 Stylus, #53 payments, #54 ERC-8004, #55 pipeline.
