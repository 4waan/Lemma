/** Static: what Lemma is and how to install the bridge. Nothing here comes from the API. */
export function Overview() {
  const mcpConfig = JSON.stringify(
    { mcpServers: { lemma: { command: "node", args: ["<path to your Lemma checkout>/apps/bridge/dist/main.js"], env: { LEMMA_API_URL: "https://<this server>" } } } },
    null,
    2,
  );
  return (
    <section>
      <h2>What Lemma does</h2>
      <p>
        Coding agents keep rebuilding the same integrations. Lemma sells a verified, benchmarked patch for a known integration task, priced below the model cost it saves,
        and backed by a warranty. Before an agent builds, it asks Lemma for a free preview: a decision to reuse, adapt, build or decline, from package metadata only.
      </p>
      <p>
        A release is sold only when a frozen, paired benchmark measured its saving, and only at a price of at most 30% of that saving that still leaves the buyer at least 25%
        lower all-in cost after gas. The one exception is testnet-only provisional evidence: rough numbers from an exploratory probe, labeled wherever they appear, so the paid
        path can be exercised before a frozen benchmark exists. The Catalog and Evidence views show the numbers for every profile.
      </p>
      <h2>Set up</h2>
      <p>The bridge is not published as a package yet: build it from a Lemma checkout with <code>npm ci &amp;&amp; npm run build</code>.</p>
      <ol>
        <li>
          Add the bridge to your agent's MCP configuration (<code>.cursor/mcp.json</code>):
          <pre>{mcpConfig}</pre>
        </li>
        <li>
          Install the Lemma rule into your project: <code>node &lt;path to your Lemma checkout&gt;/apps/bridge/dist/main.js install-rule .</code>
        </li>
        <li>The agent then calls <code>lemma_preview</code> before building a supported integration.</li>
      </ol>
      <h2>What to trust</h2>
      <ul>
        <li>Everything here runs on a testnet. Amounts are test USDC.</li>
        <li>Evidence marked provisional comes from an exploratory probe, not a frozen benchmark, and exists only on testnet.</li>
        <li>The server, the provider and the evaluator are operated by the Lemma team. This demonstrates an economic mechanism, not trustless software correctness.</li>
      </ul>
    </section>
  );
}
