import { CatalogView, DemandView, ResolutionView, StatusView } from "@lemma/core";
import { type ReactNode, useEffect, useState } from "react";

import { type Loaded, useView } from "./api.js";
import { Icon } from "./components/Icon.js";
import { Logo, MarkMono } from "./components/Logo.js";
import { Callout, EmptyState } from "./components/ui.js";
import { FOOTER_NAV, NAV, type Route, parseRoute, titleFor } from "./routes.js";
import { Catalog } from "./views/Catalog.js";
import { Demand } from "./views/Demand.js";
import { Evidence } from "./views/Evidence.js";
import { Overview } from "./views/Overview.js";
import { Resolution, ResolutionLookup } from "./views/Resolution.js";
import { Setup } from "./views/Setup.js";
import { Status } from "./views/Status.js";

/** The dashboard shell: the header and its navigation, the view the URL fragment names, and the footer with the explorer pages. */
export function App({ initialHash = typeof window === "undefined" ? "" : window.location.hash }: { initialHash?: string }) {
  const [route, setRoute] = useState<Route>(() => parseRoute(initialHash));
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    const update = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  useEffect(() => {
    document.title = titleFor(route);
    setMenuOpen(false);
    const anchor = "anchor" in route ? route.anchor : null;
    const target = anchor === null ? null : document.getElementById(anchor);
    if (target === null) window.scrollTo(0, 0);
    else target.scrollIntoView();
  }, [route]);
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <div className="container header-inner">
          <a className="brand" href="#/" aria-label="Lemma home">
            <Logo />
          </a>
          <nav id="site-nav" className={menuOpen ? "site-nav open" : "site-nav"} aria-label="Main">
            {NAV.map((item) => (
              <a key={item.href} href={item.href} aria-current={item.view === route.view ? "page" : undefined}>
                {item.label}
              </a>
            ))}
            <span className="pill testnet" title="Every amount is test USDC on Arbitrum Sepolia">
              Testnet
            </span>
          </nav>
          <div className="header-actions">
            <a className="btn btn-primary btn-sm" href="#/setup" aria-current={route.view === "setup" ? "page" : undefined}>
              Get started
            </a>
            <button type="button" className="menu-btn" aria-expanded={menuOpen} aria-controls="site-nav" onClick={() => setMenuOpen((open) => !open)}>
              <Icon name={menuOpen ? "x" : "menu"} size={20} />
              <span className="sr-only">Menu</span>
            </button>
          </div>
        </div>
      </header>
      <main className="container" id="main">
        <RouteView route={route} />
      </main>
      <footer className="site-footer">
        <div className="container footer-inner">
          <div className="footer-brand">
            <span className="lockup small-lockup">
              <MarkMono size={20} />
              <span className="wordmark">Lemma</span>
            </span>
            <p className="small muted">Testnet only: every amount is test USDC on Arbitrum Sepolia. This read-only dashboard holds no keys and cannot sign or change anything.</p>
          </div>
          <nav className="footer-nav" aria-label="More">
            {FOOTER_NAV.map((item) => (
              <a key={item.href} href={item.href}>
                {item.label}
              </a>
            ))}
          </nav>
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
      return route.id === null ? <ResolutionLookup /> : <ResolutionPage key={route.id} id={route.id} />;
    case "not-found":
      return (
        <EmptyState title="Nothing at this address">
          <p>
            There is nothing at this address. <a href="#/">Back to the home page</a>.
          </p>
        </EmptyState>
      );
  }
}

/**
 * A resolution, with explorer links once the status names the explorer. The
 * resolution renders as soon as it loads; its links appear when the status
 * does, and stay off if the status fails or the server turned them off.
 */
function ResolutionPage({ id }: { id: string }) {
  const status = useView<StatusView>("/api/v1/status", StatusView);
  const explorer = status.state === "ready" ? status.data.chain.explorer : null;
  return <Remote path={`/api/v1/resolutions/${id}`} schema={ResolutionView} render={(v) => <Resolution view={v} explorer={explorer} />} />;
}

function Remote<T>({ path, schema, render }: { path: string; schema: Parameters<typeof useView<T>>[1]; render: (view: T) => ReactNode }) {
  return <Shown loaded={useView(path, schema)} render={render} />;
}

/** One Remote per view, so React never reuses one view's loader for another. */
function View<T>(props: { path: string; schema: Parameters<typeof useView<T>>[1]; render: (view: T) => ReactNode; name: string }) {
  return <Remote key={`${props.name}:${props.path}`} path={props.path} schema={props.schema} render={props.render} />;
}

export function Shown<T>({ loaded, render }: { loaded: Loaded<T>; render: (view: T) => ReactNode }) {
  if (loaded.state === "loading") return <Loading />;
  if (loaded.state === "error")
    return (
      <Callout tone="danger" title="This view could not be loaded">
        <p>{loaded.message}</p>
      </Callout>
    );
  return <>{render(loaded.data)}</>;
}

/** The mark, nudging down like its arrow, while a view loads. */
export function Loading() {
  return (
    <p className="loading" role="status">
      <MarkMono size={22} className="mark-loading" />
      Loading…
    </p>
  );
}
