import type { ReactNode } from "react";

import { Icon, type IconName } from "./Icon.js";
import { MarkMono } from "./Logo.js";

export type Tone = "neutral" | "accent" | "ok" | "warn" | "danger";

export function Badge({ tone = "neutral", children }: { tone?: Tone | undefined; children: ReactNode }) {
  return <span className={tone === "neutral" ? "badge" : `badge ${tone}`}>{children}</span>;
}

/** A note set apart from the text: `info` explains, `warn` qualifies a claim, `danger` reports a failure. */
export function Callout({ tone = "info", title, children }: { tone?: "info" | "warn" | "danger" | undefined; title?: string | undefined; children: ReactNode }) {
  const icon: IconName = tone === "info" ? "info" : "alert";
  return (
    <div className={tone === "info" ? "callout" : `callout ${tone}`} role="note">
      <Icon name={icon} size={18} />
      <div>
        {title === undefined ? null : <strong className="callout-title">{title}</strong>}
        {children}
      </div>
    </div>
  );
}

export function PageHead({ eyebrow, title, children }: { eyebrow?: string | undefined; title: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-head">
      {eyebrow === undefined ? null : <span className="eyebrow">{eyebrow}</span>}
      <h1>{title}</h1>
      {children}
    </header>
  );
}

export function Section({ title, intro, id, children }: { title: string; intro?: ReactNode; id?: string | undefined; children: ReactNode }) {
  return (
    <section className="section" id={id}>
      <div className="section-head">
        <h2>{title}</h2>
        {intro === undefined ? null : <p>{intro}</p>}
      </div>
      {children}
    </section>
  );
}

/** Label and value pairs as a description list. */
export function KeyValue({ items }: { items: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl className="kv">
      {items.map(([label, value]) => (
        <div key={label} className="kv-row">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One figure in a `.stats` list: a label, a value in proportional figures, and an optional note. */
export function Stat({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: "ok" | "warn" | "danger" | undefined }) {
  return (
    <div className={tone === undefined ? "stat" : `stat ${tone}`}>
      <dt>{label}</dt>
      <dd>
        {value}
        {note === undefined ? null : <span className="stat-note">{note}</span>}
      </dd>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty">
      <MarkMono size={30} />
      <h3>{title}</h3>
      {children}
    </div>
  );
}

/** A plan in the pricing section: its price, the unit the price is in, and what it includes. */
export function PricingCard({
  name,
  price,
  unit,
  featured = false,
  items,
}: {
  name: string;
  price: ReactNode;
  unit?: ReactNode;
  featured?: boolean | undefined;
  items: ReadonlyArray<readonly [key: string, content: ReactNode]>;
}) {
  return (
    <div className={featured ? "price-card featured" : "price-card"}>
      <h3>{name}</h3>
      <p className="price">
        <span className="price-figure">{price}</span>
        {unit === undefined ? null : <span className="price-unit">{unit}</span>}
      </p>
      <ul className="price-items">
        {items.map(([key, content]) => (
          <li key={key}>
            <Icon name="check" size={16} />
            <span>{content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A dark product panel with a title bar, for a session transcript or a live readout. */
export function Panel({ title, badge, label, className, children }: { title: string; badge?: ReactNode; label: string; className?: string | undefined; children: ReactNode }) {
  return (
    <aside className={className === undefined ? "panel" : `panel ${className}`} aria-label={label}>
      <div className="panel-head">
        <span>{title}</span>
        {badge}
      </div>
      {children}
    </aside>
  );
}
