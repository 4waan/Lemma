/** The dashboard's views, addressed by URL fragment so the server serves one page. */
export type Route =
  | { readonly view: "overview"; readonly anchor: "how-it-works" | null }
  | { readonly view: "catalog" }
  | { readonly view: "evidence"; readonly anchor: "what-to-trust" | null }
  | { readonly view: "demand" }
  | { readonly view: "status" }
  | { readonly view: "setup" }
  | { readonly view: "resolution"; readonly id: string | null }
  | { readonly view: "not-found" };

const HEX32 = /^0x[0-9a-f]{64}$/;

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, "");
  if (path === "" || path === "overview") return { view: "overview", anchor: null };
  if (path === "how-it-works") return { view: "overview", anchor: "how-it-works" };
  if (path === "evidence") return { view: "evidence", anchor: null };
  if (path === "what-to-trust") return { view: "evidence", anchor: "what-to-trust" };
  if (path === "catalog" || path === "demand" || path === "status" || path === "setup") return { view: path };
  if (path === "resolutions") return { view: "resolution", id: null };
  const match = /^resolutions\/(.+)$/.exec(path);
  if (match !== null) return HEX32.test(match[1] as string) ? { view: "resolution", id: match[1] as string } : { view: "not-found" };
  return { view: "not-found" };
}

export interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly view: Route["view"];
}

/** The header: the story, the catalog and the proof. Get started is the header's button. */
export const NAV: readonly NavItem[] = [
  { href: "#/how-it-works", label: "How it works", view: "overview" },
  { href: "#/catalog", label: "Catalog", view: "catalog" },
  { href: "#/evidence", label: "Proof", view: "evidence" },
];

/** The footer: the explorer pages. */
export const FOOTER_NAV: readonly NavItem[] = [
  { href: "#/resolutions", label: "Resolutions", view: "resolution" },
  { href: "#/demand", label: "Demand", view: "demand" },
  { href: "#/status", label: "Status", view: "status" },
  { href: "#/what-to-trust", label: "What to trust", view: "evidence" },
];

const LABEL: Readonly<Record<Route["view"], string>> = {
  overview: "Home",
  catalog: "Catalog",
  evidence: "Proof",
  demand: "Demand",
  status: "Status",
  setup: "Get started",
  resolution: "Resolutions",
  "not-found": "Not found",
};

/** The document title for a route, so tabs and history entries name the view. */
export function titleFor(route: Route): string {
  return route.view === "overview" ? "Lemma · Verified integrations for coding agents" : `${LABEL[route.view]} · Lemma`;
}
