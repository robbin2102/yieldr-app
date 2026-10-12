"use client";
import { useState } from "react";
import type { Position } from "@/types/edge";
import { chartPoints } from "@/lib/edge/domain";
import { tokenLabel } from './CoinHoldings';
import { money, date } from "./shared";
export default function PositionsChart({
  positions,
  window,
  compact=false,
}: {
  compact?:boolean;
  positions: Position[];
  window?: { start: string; end: string };
}) {
  const [selected, setSelected] = useState<Position | null>(null);
  const height=compact?150:240;
  const points = chartPoints(positions, 800, height, window);
  const priced = positions.filter((p) => p.includedInDollarTotals).length;
  return (
    <section className="edge-card position-chart">
      <div className="section-heading">
        <h2 className="edge-label">Your last 90 days</h2>
        <span className="small edge-muted">Each dot = a position · up = win · down = loss</span>
      </div>
      {positions.length === 0 ? (
        <p className="empty-state">
          No closed positions in the verified analysis window.
        </p>
      ) : (
        <svg
          viewBox={`0 0 800 ${height}`}
          role="group"
          aria-label={`${positions.length} closed positions; ${priced} priced`}
        >
          <line x1="0" x2="800" y1={height/2} y2={height/2} stroke="#303648" />
          {points.map(({ position: p, x, y, radius, hollow }) => (
            <circle
              key={p.episodeId}
              className="position-dot"
              cx={x}
              cy={y}
              r={radius}
              fill={
                hollow
                  ? "transparent"
                  : Number(p.realizedPnlUsd) >= 0
                    ? "#3DDC84"
                    : "#FF7A6B"
              }
              stroke={hollow ? "#8791AB" : "transparent"}
              opacity=".85"
              tabIndex={0}
              role="button"
              aria-label={`${tokenLabel(p.tokenSymbol,p.tokenAddress)}: ${money(p.realizedPnlUsd)}. ${date(p.closedAt)}`}
              onClick={() => setSelected(p)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setSelected(p);
                }
              }}
            >
              <title>
                {tokenLabel(p.tokenSymbol,p.tokenAddress)} · {money(p.realizedPnlUsd)}
              </title>
            </circle>
          ))}
        </svg>
      )}
      <div className="section-heading small edge-muted">
        <span>{date(window?.start || positions[0]?.closedAt || null)}</span>
        <span>{date(window?.end || positions.at(-1)?.closedAt || null)}</span>
      </div>
      {compact ? <p className="small edge-muted">{positions.length} positions · {priced} priced · hollow = price missing</p> : <>
      <p className="small edge-muted">
        {positions.length} positions · {priced} priced ·{" "}
        {positions.length - priced} excluded from dollar totals. Hollow =
        incomplete USD pricing. Size = verified acquisition cost; a neutral size
        is used when cost is unavailable.
      </p>
      <details className="position-table">
        <summary>View position values</summary>
        <div className="table-scroll">
          <table>
            <caption>Closed episodes in chronological order</caption>
            <thead><tr><th scope="col">Token / chain</th><th scope="col">Closed</th><th scope="col">Realized P&amp;L</th></tr></thead>
            <tbody>{points.map(({position:p})=><tr key={p.episodeId}><th scope="row">{tokenLabel(p.tokenSymbol,p.tokenAddress)}<small>{p.chain}</small></th><td>{date(p.closedAt)}</td><td>{money(p.realizedPnlUsd)}</td></tr>)}</tbody>
          </table>
        </div>
      </details>
      </>}
      {selected && (
        <div className="chart-detail" role="status">
          <b>{tokenLabel(selected.tokenSymbol,selected.tokenAddress)}</b>
          <p>
            {selected.chain} · {selected.buyCount} buys / {selected.sellCount}{" "}
            sells · {money(selected.realizedPnlUsd)} realized P&amp;L
          </p>
          <p>
            Verified FIFO acquisition cost:{" "}
            {money(selected.verifiedAcquisitionCostUsd)}
          </p>
          <button className="edge-button" onClick={() => setSelected(null)}>
            Close details
          </button>
        </div>
      )}
    </section>
  );
}
