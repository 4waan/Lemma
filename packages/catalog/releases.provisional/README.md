# Provisional overlay (testnet only)

Nothing in the catalog is sellable without evidence, yet stage 5 (the paid path) needs an offer to buy, and stage 6 (the frozen benchmark) needs the treatment arm to pay for its resolution. This overlay breaks that loop without weakening the public catalog.

- It holds only `X+provisional-N` versions of releases in `../releases/`. They are identical to `X` except for the version, evidence, price and dates (`catalog:check` compares `baseReleaseDigest`).
- The evidence carries the stage-4 probe numbers and `benchmarkVersion: "provisional-N"`, and the release is priced at the pre-registered price (`maxPriceFor` from the probe).
- The server loads the overlay only when it is explicitly allowed to (`loadCatalog({ includeProvisional: true })`). The public deployment never does. The `+provisional-N` suffix is visible in every matched release version, so a provisional offer can never be mistaken for a benchmarked one.
- `catalog:check` refuses `provisional-` evidence in `../releases/`, and `deriveEvidence` refuses `provisional-` and `probe-` benchmark versions, so provisional numbers can never become or be served as public evidence. Frozen evidence replaces them as `X+<benchmarkVersion>` in `../releases/`.
