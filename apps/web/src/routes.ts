/** The dashboard's views, addressed by URL fragment so the server serves one page. */
export type Route =
  | { readonly view: "overview" }
  | { readonly view: "catalog" }
  | { readonly view: "evidence" }
  | { readonly view: "demand" }
  | { readonly view: "status" }
  | { readonly view: "resolution"; readonly id: string | null }
  | { readonly view: "not-found" };

const HEX32 = /^0x[0-9a-f]{64}$/;

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, "");
  if (path === "" || path === "overview") return { view: "overview" };
  if (path === "catalog" || path === "evidence" || path === "demand" || path === "status") return { view: path };
  if (path === "resolutions") return { view: "resolution", id: null };
  const match = /^resolutions\/(.+)$/.exec(path);
  if (match !== null) return HEX32.test(match[1] as string) ? { view: "resolution", id: match[1] as string } : { view: "not-found" };
  return { view: "not-found" };
}

export const NAV: ReadonlyArray<{ readonly href: string; readonly label: string; readonly view: Route["view"] }> = [
  { href: "#/", label: "Overview", view: "overview" },
  { href: "#/catalog", label: "Catalog", view: "catalog" },
  { href: "#/evidence", label: "Evidence", view: "evidence" },
  { href: "#/demand", label: "Unmet demand", view: "demand" },
  { href: "#/resolutions", label: "Resolutions", view: "resolution" },
  { href: "#/status", label: "Status", view: "status" },
];
