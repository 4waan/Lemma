# Compatibility Fixtures

Fixtures prove the narrow repository profiles that a Capability Release supports. They are part of the economic evidence, not sample decoration.

Each release should have:

- An exact supported fixture.
- A supported boundary fixture where applicable.
- At least one near-match that must be rejected.
- At least one unsupported-language or unsupported-runtime fixture.
- Frozen expected test results.

Fixtures must be public, synthetic, free of secrets, and small enough for repeated benchmark runs. Changes require a release version or an explicit evidence revision.

## Case files

Each case is one file, `<capability>/<kebab-case-name>.json` (schema `FixtureCase` in `src/fixtures.ts`):

```json
{
  "class": "exact | boundary | near-miss | unsupported | no-release",
  "capability": "mcp-server.add-payment-gating",
  "now": "2026-10-01T00:00:00.000Z",
  "profile": { "...": "a RepositoryProfile, exactly as the bridge would send it" },
  "expected": {
    "decision": "reuse | build | decline",
    "reasons": ["sorted reason codes"],
    "match": { "releaseId": "…", "version": "…", "profileIndex": 0 },
    "offer": false
  }
}
```

- `now` pins the instant the case is judged at, so expiry and staleness never change an expected decision with the calendar.
- `exact` and `boundary` cases expect `reuse` and name their match.
- `near-miss` cases expect `build` or `decline`.
- `unsupported` cases expect `decline`.
- `no-release` cases pin the answer for a capability without releases, which is always `build` with `NO_RELEASE_FOR_CAPABILITY`. Such a capability has no other cases, and a capability with releases has no `no-release` case.

Reasons must be an answer the resolver can give: a `reuse` is held back by one sale blocker at most, a `decline` names an unsupported platform, a `build` names none, and `NO_RELEASE_FOR_CAPABILITY` stands alone.

`catalog:check` enforces coverage: every release family has an exact case, and every capability with a release has a near-miss case and an unsupported-language or unsupported-runtime case. The resolver's golden tests run every case.
