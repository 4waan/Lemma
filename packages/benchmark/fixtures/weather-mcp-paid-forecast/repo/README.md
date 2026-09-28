# weather-mcp

An MCP server with two tools over stdio:

- `get_alerts`: the active weather alerts for a US state.
- `get_forecast`: the forecast for the next three periods at a latitude and longitude.

It answers from a bundled sample of National Weather Service data (`src/weather.ts`), so it works offline.

```bash
npm ci
npm run build
npm start
```

`npm test` typechecks and runs the tests in `test/`.
