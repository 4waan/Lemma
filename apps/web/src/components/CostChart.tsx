import { formatUsdc } from "@lemma/core";
import { useCallback, useState } from "react";

import { usdcAmount } from "../format.js";

export type CostKey = "model" | "price" | "gas";

const ORDER: readonly CostKey[] = ["model", "price", "gas"];

export const COST_LABEL: Readonly<Record<CostKey, string>> = {
  model: "Model cost",
  price: "Lemma price",
  gas: "Chain cost",
};

interface Row {
  readonly label: string;
  readonly parts: Readonly<Record<CostKey, bigint>>;
}

const BAR_HEIGHT = 24;
const MARK_HEIGHT = 20;
/** The surface gap between touching segments, and the narrowest a non-zero segment is drawn. */
const GAP = 2;
const MIN_MARK = 3;
/** Plot width before the first measurement, and in server-side renders. */
const FALLBACK_WIDTH = 640;

/** A clean tick step (1, 2, 2.5 or 5 times a power of ten) giving about four intervals. */
function niceStep(max: number): number {
  const raw = max / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const n = raw / power;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * power;
}

/** Atomic USDC as a plotting number. Positions only: every printed value comes from the bigint. */
const plot = (atomic: bigint) => Number(atomic) / 1e6;

/** A bar segment square at its start and rounded at its data end. */
function dataEndPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h / 2);
  return `M${x} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x}Z`;
}

/**
 * The rendered width of the plot, so marks are drawn in pixels: exact gaps,
 * rounded ends that never stretch, and labels that never scale with the
 * container. Server-side renders and tests use the fallback.
 */
function usePlotWidth(): [(node: HTMLDivElement | null) => (() => void) | undefined, number] {
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  const ref = useCallback((node: HTMLDivElement | null) => {
    if (node === null || typeof ResizeObserver === "undefined") return undefined;
    const measure = () => setWidth(Math.max(1, Math.round(node.getBoundingClientRect().width)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** "With Lemma" reads "with Lemma" mid-sentence: only the first letter changes case. */
const midSentence = (label: string) => `${label.charAt(0).toLowerCase()}${label.slice(1)}`;

/**
 * Cost to reach passing tests, building it yourself against buying the
 * resolution: one axis, one bar each, the Lemma bar stacked from its model
 * cost, price and chain cost. It is the picture of `allInReductionBps`:
 * (C - (C - S + P + g)) / C. A values table below carries every number, so
 * hovering is never needed to read one.
 */
export function CostComparison({ control, residual, price, gas, caption }: { control: bigint; residual: bigint; price: bigint; gas: bigint; caption: string }) {
  const [active, setActive] = useState<{ row: number; key: CostKey } | null>(null);
  const [plotRef, width] = usePlotWidth();
  const rows: readonly Row[] = [
    { label: "Build it yourself", parts: { model: control, price: 0n, gas: 0n } },
    { label: "With Lemma", parts: { model: residual, price, gas } },
  ];
  const totals = rows.map((r) => r.parts.model + r.parts.price + r.parts.gas);
  const top = Math.max(...totals.map(plot));
  const step = top > 0 ? niceStep(top) : 1;
  const axisMax = top > 0 ? Math.ceil(top / step - 1e-9) * step : 1;
  const ticks: number[] = [];
  for (let t = 0; t <= axisMax + step / 2 && ticks.length <= 12; t += step) ticks.push(t);
  const px = (value: number) => (value / axisMax) * width;
  const tickLabel = (t: number) => formatUsdc(BigInt(Math.round(t * 1e6)));

  const activeRow = active === null ? undefined : rows[active.row];
  const readout =
    active === null || activeRow === undefined ? (
      "Hover over or focus a bar segment to read its value."
    ) : (
      <>
        <strong>{usdcAmount(activeRow.parts[active.key])} USDC</strong> · {COST_LABEL[active.key]}, {midSentence(activeRow.label)}
      </>
    );

  return (
    <figure className="cost-chart">
      <figcaption>{caption}</figcaption>
      <ul className="legend">
        {ORDER.map((key) => (
          <li key={key}>
            <span className={`swatch seg-${key}`} aria-hidden="true" />
            {COST_LABEL[key]}
          </li>
        ))}
      </ul>
      <div ref={plotRef} className="cost-plot">
        {rows.map((row, rowIndex) => {
          const present = ORDER.filter((key) => row.parts[key] > 0n);
          let cursor = 0;
          const marks = present.map((key, i) => {
            const lead = i === 0 ? 0 : GAP;
            const w = Math.max(MIN_MARK, px(plot(row.parts[key])) - lead);
            const x = cursor + lead;
            cursor = x + w;
            return { key, x, w, last: i === present.length - 1 };
          });
          const y = (BAR_HEIGHT - MARK_HEIGHT) / 2;
          return (
            <div className="cost-row" key={row.label}>
              <div className="cost-row-head">
                <span>{row.label}</span>
                <strong>{usdcAmount(totals[rowIndex] ?? 0n)} USDC</strong>
              </div>
              <svg className="cost-bar" width={width} height={BAR_HEIGHT} role="group" aria-label={`${row.label}: ${usdcAmount(totals[rowIndex] ?? 0n)} USDC`}>
                {ticks.map((t) => (
                  <line key={t} className="cost-grid" x1={px(t)} x2={px(t)} y1={0} y2={BAR_HEIGHT} />
                ))}
                {marks.map(({ key, x, w, last }) => {
                  const dim = active !== null && !(active.row === rowIndex && active.key === key);
                  const show = () => setActive({ row: rowIndex, key });
                  const hide = () => setActive(null);
                  const props = {
                    className: `cost-seg seg-${key}${dim ? " dim" : ""}`,
                    tabIndex: 0,
                    role: "img",
                    "aria-label": `${COST_LABEL[key]}: ${usdcAmount(row.parts[key])} USDC`,
                    onMouseEnter: show,
                    onMouseLeave: hide,
                    onFocus: show,
                    onBlur: hide,
                  };
                  // Only the data end is rounded; a segment that touches another stays square.
                  return last ? <path key={key} d={dataEndPath(x, y, w, MARK_HEIGHT)} {...props} /> : <rect key={key} x={x} y={y} width={w} height={MARK_HEIGHT} {...props} />;
                })}
              </svg>
            </div>
          );
        })}
        <svg className="cost-axis" width={width} height={18} aria-hidden="true">
          {ticks.map((t, i) => (
            <text key={t} x={px(t)} y={13} textAnchor={i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"}>
              {tickLabel(t)}
            </text>
          ))}
        </svg>
      </div>
      <p className="cost-readout" aria-live="polite">
        {readout}
      </p>
      <div className="table-wrap">
        <table className="cost-table">
          <caption className="sr-only">{caption}, in USDC</caption>
          <thead>
            <tr>
              <th scope="col">USDC per resolution</th>
              {rows.map((row) => (
                <th key={row.label} scope="col" className="num">
                  {row.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ORDER.map((key) => (
              <tr key={key}>
                <th scope="row">
                  <span className={`swatch seg-${key}`} aria-hidden="true" /> {COST_LABEL[key]}
                </th>
                {rows.map((row) => (
                  <td key={row.label} className="num">
                    {key !== "model" && row.label === "Build it yourself" ? "–" : usdcAmount(row.parts[key])}
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <th scope="row">Total</th>
              {totals.map((total, i) => (
                <td key={rows[i]?.label ?? i} className="num">
                  <strong>{usdcAmount(total)}</strong>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </figure>
  );
}
