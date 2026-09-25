import { CatalogView, DemandView, ResolutionView, StatusView } from "@lemma/core";
import { type ReactNode, useEffect, useState } from "react";

import { type Loaded, useView } from "./api.js";
import { NAV, type Route, parseRoute } from "./routes.js";
import { Catalog } from "./views/Catalog.js";
import { Demand } from "./views/Demand.js";
import { Evidence } from "./views/Evidence.js";
import { Overview } from "./views/Overview.js";
import { Resolution } from "./views/Resolution.js";
import { Status } from "./views/Status.js";

/** The dashboard shell: a testnet banner, navigation, and the view the URL fragment names. */
export function App({ initialHash = typeof window === "undefined" ? "" : window.location.hash }: { initialHash?: string }) {
  const [route, setRoute] = useState<Route>(() => parseRoute(initialHash));
  useEffect(() => {
    const update = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return (
    <>
      <header>
        <h1>Lemma</h1>
        <p className="tagline">Verified, benchmarked integrations for coding agents, priced below the tokens they save.</p>
        <p className="banner">Testnet: every amount is test USDC, and nothing here is financial or production advice.</p>
        <nav>
          {NAV.map((item) => (
            <a key={item.href} href={item.href} aria-current={item.view === route.view ? "page" : undefined}>
              {item.label}
            </a>
          ))}
        </nav>
      </header>
      <main>
        <RouteView route={route} />
      </main>
    </>
  );
}

function RouteView({ route }: { route: Route }) {
  switch (route.view) {
    case "overview":
      return <Overview />;
    case "catalog":
      return <View name="catalog" path="/api/v1/catalog" schema={CatalogView} render={(v) => <Catalog view={v} />} />;
    case "evidence":
      return <View name="evidence" path="/api/v1/catalog" schema={CatalogView} render={(v) => <Evidence view={v} />} />;
    case "demand":
      return <View name="demand" path="/api/v1/demand" schema={DemandView} render={(v) => <Demand view={v} />} />;
    case "status":
      return <View name="status" path="/api/v1/status" schema={StatusView} render={(v) => <Status view={v} />} />;
    case "resolution":
      return route.id === null ? <ResolutionLookup /> : <View name="resolution" path={`/api/v1/resolutions/${route.id}`} schema={ResolutionView} render={(v) => <Resolution view={v} />} />;
    case "not-found":
      return <p>There is nothing at this address.</p>;
  }
}

function Remote<T>({ path, schema, render }: { path: string; schema: Parameters<typeof useView<T>>[1]; render: (view: T) => ReactNode }) {
  return <Shown loaded={useView(path, schema)} render={render} />;
}

/** One Remote per view, so React never reuses one view's loader for another. */
function View<T>(props: { path: string; schema: Parameters<typeof useView<T>>[1]; render: (view: T) => ReactNode; name: string }) {
  return <Remote key={`${props.name}:${props.path}`} path={props.path} schema={props.schema} render={props.render} />;
}

export function Shown<T>({ loaded, render }: { loaded: Loaded<T>; render: (view: T) => ReactNode }) {
  if (loaded.state === "loading") return <p className="meta">Loading…</p>;
  if (loaded.state === "error") return <p className="error">{loaded.message}</p>;
  return <>{render(loaded.data)}</>;
}

/** Looks a resolution up by id. A resolution id is public; the preview id that recovers it never appears here. */
function ResolutionLookup() {
  const [id, setId] = useState("");
  const valid = /^0x[0-9a-f]{64}$/.test(id.trim().toLowerCase());
  return (
    <section>
      <h2>Look up a resolution</h2>
      <label>
        Resolution id <input value={id} onChange={(e) => setId(e.target.value)} placeholder="0x…" spellCheck={false} size={70} />
      </label>{" "}
      {valid ? <a href={`#/resolutions/${id.trim().toLowerCase()}`}>Show</a> : <span className="meta">a 0x-prefixed 32-byte hex id</span>}
    </section>
  );
}
