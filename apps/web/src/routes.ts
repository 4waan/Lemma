/** The home page's sections a link may land on. */
export type HomeAnchor = "how-it-works" | "arbitrum" | "pricing";

/** The dashboard's views, addressed by URL fragment so the server serves one page. */
export type Route =
  | { readonly view: "overview"; readonly anchor: HomeAnchor | null }
  | { readonly view: "catalog" }
  | { readonly view: "benchmark"; readonly anchor: "what-to-trust" | null }
  | { readonly view: "demand" }
  | { readonly view: "status"; readonly anchor: "verify" | null }
  | { readonly view: "connect" }
  | { readonly view: "resolution"; readonly id: string | null }
  | { readonly view: "not-found" };

const HEX32 = /^0x[0-9a-f]{64}$/;

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, "");
  if (path === "" || path === "overview") return { view: "overview", anchor: null };
  if (path === "how-it-works" || path === "arbitrum" || path === "pricing") return { view: "overview", anchor: path };
  // "evidence" and "setup" are the pages' earlier names; links to them still land.
  if (path === "benchmark" || path === "evidence") return { view: "benchmark", anchor: null };
  if (path === "what-to-trust") return { view: "benchmark", anchor: "what-to-trust" };
  if (path === "connect" || path === "setup") return { view: "connect" };
  if (path === "status") return { view: "status", anchor: null };
  if (path === "verify") return { view: "status", anchor: "verify" };
  if (path === "catalog" || path === "demand") return { view: path };
  if (path === "resolutions") return { view: "resolution", id: null };
  const match = /^resolutions\/(.+)$/.exec(path);
  if (match !== null) return HEX32.test(match[1] as string) ? { view: "resolution", id: match[1] as string } : { view: "not-found" };
  return { view: "not-found" };
}

export interface NavItem {
  readonly href: string;
  readonly label: string;
  /** The view it opens; null for a link that leaves the site. */
  readonly view: Route["view"] | null;
  /** For a section of a page: which one. */
  readonly anchor?: HomeAnchor | "verify" | undefined;
}

/**
 * Whether a link names the page on screen: its view, and for a section, that
 * section. The home page itself is the logo's link.
 */
export function isCurrent(item: NavItem, route: Route): boolean {
  if (item.view !== route.view) return false;
  if (route.view === "overview") return item.anchor !== undefined && item.anchor === route.anchor;
  if (route.view === "status") return (item.anchor ?? null) === route.anchor;
  return true;
}

/** Lemma's source code. */
export const REPOSITORY_URL = "https://github.com/4waan/Lemma";

/** The header's links. Connect your agent is the header's button. */
export const NAV: readonly NavItem[] = [
  { href: "#/catalog", label: "Catalog", view: "catalog" },
  { href: "#/resolutions", label: "Resolutions", view: "resolution" },
  { href: "#/benchmark", label: "Benchmark", view: "benchmark" },
  { href: "#/status", label: "Status", view: "status" },
  { href: REPOSITORY_URL, label: "GitHub", view: null },
];

/** The one place the site names its network, beside the home page's section about it. */
export const NETWORK_LABEL = "Arbitrum Sepolia";

/** The footer's link columns. */
export const FOOTER_COLUMNS: ReadonlyArray<{ readonly title: string; readonly items: readonly NavItem[] }> = [
  {
    title: "Product",
    items: [
      { href: "#/how-it-works", label: "How it works", view: "overview", anchor: "how-it-works" },
      { href: "#/catalog", label: "Catalog", view: "catalog" },
      { href: "#/pricing", label: "Pricing", view: "overview", anchor: "pricing" },
      { href: "#/connect", label: "Connect your agent", view: "connect" },
    ],
  },
  {
    title: "Explore",
    items: [
      { href: "#/resolutions", label: "Resolutions", view: "resolution" },
      { href: "#/demand", label: "Demand", view: "demand" },
      { href: "#/status", label: "Status", view: "status" },
    ],
  },
  {
    title: "Trust",
    items: [
      { href: "#/benchmark", label: "Benchmark", view: "benchmark" },
      { href: "#/what-to-trust", label: "What to trust", view: "benchmark" },
      { href: "#/verify", label: "Verify it yourself", view: "status", anchor: "verify" },
    ],
  },
];

/** What Lemma runs on, named in the footer as plain text: no logos and no links, so nothing implies an affiliation. */
export const BUILT_ON: readonly string[] = ["Arbitrum", "Stylus", "x402", "USDC", "ERC-8004"];

const LABEL: Readonly<Record<Route["view"], string>> = {
  overview: "Home",
  catalog: "Catalog",
  benchmark: "Benchmark",
  demand: "Demand",
  status: "Status",
  connect: "Connect your agent",
  resolution: "Resolutions",
  "not-found": "Not found",
};

/** The document title for a route, so tabs and history entries name the view. */
export function titleFor(route: Route): string {
  return route.view === "overview" ? "Lemma · Tested integrations for coding agents" : `${LABEL[route.view]} · Lemma`;
}
