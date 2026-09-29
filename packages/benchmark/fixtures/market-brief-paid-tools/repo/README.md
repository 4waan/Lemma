# market-brief

An agent that writes a short company brief from the tools of three MCP servers:

- `market.get_quote`: the latest quote for a ticker.
- `filings.get_filing_summary`: a summary of the latest filing.
- `news.search_news`: recent headlines.

A section whose tool fails says why instead of failing the brief.

```bash
npm ci
npm run build
npm start -- ACME servers.json
```

`servers.json` maps each server name to the command that starts it over stdio. `npm test` typechecks and runs the tests in `test/`.
