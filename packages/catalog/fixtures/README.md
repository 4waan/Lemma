# Compatibility Fixtures

Fixtures prove the narrow repository profiles that a Capability Release supports. They are part of the economic evidence, not sample decoration.

Each release should have:

- An exact supported fixture.
- A supported boundary fixture where applicable.
- At least one near-match that must be rejected.
- At least one unsupported-language or unsupported-runtime fixture.
- Frozen expected test results.

Fixtures must be public, synthetic, free of secrets, and small enough for repeated benchmark runs. Changes require a release version or an explicit evidence revision.
