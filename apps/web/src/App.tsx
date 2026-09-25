import { CatalogView, DemandView, ResolutionView, StatusView } from "@lemma/core";
import { type ReactNode, useEffect, useState } from "react";

import { type Loaded, useView } from "./api.js";
import { Logo } from "./components/Logo.js";
import { Callout, EmptyState } from "./components/ui.js";
import { NAV, type Route, parseRoute, titleFor } from "./routes.js";
import { Catalog } from "./views/Catalog.js";
import { Demand } from "./views/Demand.js";
import { Evidence } from "./views/Evidence.js";
import { Overview } from "./views/Overview.js";
import { Resolution, ResolutionLookup } from "./views/Resolution.js";
import { Setup } from "./views/Setup.js";
import { Status } from "./views/Status.js";

/** The dashboard shell: a testnet banner, the header and navigation, and the view the URL fragment names. */
export function App({ initialHash = typeof window === "undefined" ? "" : window.location.hash }: { initialHash?: string }) {
  const [route, setRoute] = useState<Route>(() => parseRoute(initialHash));
  useEffect(() => {
    const update = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  useEffect(() => {
    document.title = titleFor(route);
    window.scrollTo(0, 0);
  }, [route]);
  return (
    <>
      <p className="banner">Testnet: every amount is test USDC on Arbitrum Sepolia, and nothing here is financial or production advice.</p>
      <header className="site-header">
        <div className="container header-inner">
          <a className="brand" href="#/" aria-label="Lemma overview">
            <Logo />
            Lemma
          </a>
          <nav className="site-nav" aria-label="Main">
            {NAV.map((item) => (
              <a key={item.href} href={item.href} aria-current={item.view === route.view ? "page" : undefined}>
                {item.label}
              </a>
            ))}
          </nav>
        </div>
      </header>
      <main className="container" id="main">
        <RouteView route={route} />
      </main>
      <footer className="site-footer">
        <div className="container footer-inner">
          <p>Lemma: verified, benchmarked integrations for coding agents, paid in USDC through x402 on Arbitrum.</p>
          <p>Read-only dashboard. It holds no keys and cannot sign or change anything.</p>
        </div>
      </footer>
    </>
  );
}

function RouteView({ route }: { route: Route }) {
  switch (route.view) {
    case "overview":
      return <Overview />;
    case "setup":
      return <Setup />;
    case "catalog":
      return <View name="catalog" path="/api/v1/catalog" schema={CatalogView} render={(v) => <Catalog view={v} />} />;
    case "evidence":
      return <View name="evidence" path="/api/v1/catalog" schema={CatalogView} render={(v) => <Evidence view={v} />} />;
    case "demand":
      return <View name="demand" path="/api/v1/demand" schema={DemandView} render={(v) => <Demand view={v} />} />;
    case "status":
      return <View name="status" path="/api/v1/status" schema={StatusView} render={(v) => <Status view={v} />} />;
    case "resolution":
      return route.id === null ? (
        <ResolutionLookup />
      ) : (
        <View name="resolution" path={`/api/v1/resolutions/${route.id}`} schema={ResolutionView} render={(v) => <Resolution view={v} />} />
      );
    case "not-found":
      return (
        <EmptyState title="Nothing at this address">
          <p>
            There is nothing at this address. <a href="#/">Back to the overview</a>.
          </p>
        </EmptyState>
      );
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
  if (loaded.state === "loading") return <p className="loading">Loading…</p>;
  if (loaded.state === "error")
    return (
      <Callout tone="danger" title="This view could not be loaded">
        <p>{loaded.message}</p>
      </Callout>
    );
  return <>{render(loaded.data)}</>;
}
