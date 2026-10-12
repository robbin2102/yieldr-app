"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { Story, Finding } from "@/types/edge";
import { useScan } from "./useScan";
import { Header, date, money, pct, human, fetchJson } from "./shared";
import AgentDock from './AgentDock';
import {tokenLabel,shortAddress} from './CoinHoldings';
import {findingName,usefulFindings} from './findingCopy';
import Findings from "./Findings";
import PositionsChart from "./PositionsChart";
function Print({ findings, pnl }: { findings: Finding[]; pnl: string | null }) {
  const supported = usefulFindings(findings).filter(f=>f.pnl!==null).slice(0,7);
  const maximum = Math.max(
    1,
    ...supported.map((f) => Math.abs(Number(f.pnl) || 0)),
  );
  return (
    <div className="edge-card radial-print">
      <svg
        viewBox={supported.length>0 && supported.every(f=>Number(f.pnl)<0)?"0 185 640 310":"0 22 640 470"}
        role="img"
        aria-label="Edge Print. Each spoke is an observed or validated pattern, sized by its attributable historical P&L. Patterns overlap and are not additive."
      >
        <circle cx="320" cy="270" r="50" fill="#0A0E1D" stroke="#32384a" />
        {supported.map((f, i) => {
          const positive = Number(f.pnl) >= 0;
          const peers = supported.filter(item => (Number(item.pnl) >= 0) === positive);
          const index = peers.findIndex(item => item.id === f.id);
          const angles = positive ? [-90, -30, -150, -60] : [90, 130, 50, 165];
          const angle = angles[index % angles.length] * Math.PI / 180;
          const length = 35 + (Math.abs(Number(f.pnl) || 0) / maximum) * (positive ? 135 : 70);
          const x = 320 + Math.cos(angle) * (length + 58),
            y = 270 + Math.sin(angle) * (length + 58);
          const anchor = Math.cos(angle) < -0.2 ? "end" : "start";
          const labelX = x + (anchor === "end" ? -12 : 14);
          const color =
            positive ? "#3DDC84" : "#FF7A6B";
          return (
            <g key={f.id} className="print-spoke">
              <line
                x1={320 + Math.cos(angle) * 58}
                y1={270 + Math.sin(angle) * 58}
                x2={x}
                y2={y}
                stroke={color}
                strokeWidth="18"
                strokeOpacity={f.status.startsWith("validated")?1:.55}
                strokeLinecap="round"
              />
              <text
                x={labelX}
                y={y + (positive ? 14 : 15)}
                textAnchor={anchor}
                fill="#EEF1F7"
                fontSize="13"
              >
                {f.id.includes('round_trip')?'Giving back gains':f.id.includes('moonshot')?'Big-winner dependence':f.name.length>25?f.name.slice(0,24)+'…':f.name}
              </text>
              <text
                x={labelX}
                y={y + (positive ? 31 : 32)}
                textAnchor={anchor}
                fill={color}
                fontSize="13"
              >
                {money(f.pnl)} · {f.status.startsWith("validated")?"validated":"observed"}
              </text>
            </g>
          );
        })}
        <text x="320" y="272" textAnchor="middle" fill="#EEF1F7" fontSize="19">
          {pnl === null
            ? "—"
            : new Intl.NumberFormat("en-US", {
                notation: "compact",
                style: "currency",
                currency: "USD",
              }).format(Number(pnl))}
        </text>
        <text x="320" y="290" textAnchor="middle" fill="#8791AB" fontSize="13">
          historical P&amp;L
        </text>
      </svg>
      <ul className="print-mobile-legend">{supported.map(f=><li key={f.id}>{f.name}<span className="mono">{money(f.pnl)}</span></li>)}</ul>
      {supported.length === 0 && (
        <p className="empty-state">
          No priced patterns yet. Your positions and observations are shown below.
        </p>
      )}
      <p className="small edge-muted">
        Faded spokes are observations, not proven edges. Pattern results overlap; they do not add up to the total.
      </p>
    </div>
  );
}
export default function ResultView({ scanId }: { scanId: string }) {
  const { scan, result, positions, positionError, error, retry } = useScan(scanId);
  const [stories, setStories] = useState<Story[]>([]);
  const [offset, setOffset] = useState<number | null>(0);
  const [storyError, setStoryError] = useState("");
  const [loading, setLoading] = useState(false);
  
  async function loadStories(start: number) {
    setLoading(true);
    try {
      const page = await fetchJson<{
        items: Story[];
        nextOffset: number | null;
      }>(`/api/edge/scans/${scanId}/stories?offset=${start}`);
      setStories((prev) =>
        start === 0 ? page.items : [...prev, ...page.items],
      );
      setOffset(page.nextOffset);
      setStoryError("");
    } catch (e) {
      setStoryError(e instanceof Error ? e.message : "Stories unavailable");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (result) void loadStories(0);
  }, [result?.summaryId]);
  if (error)
    return (
      <>
        <Header />
        <main className="empty-state" role="alert">
          <p>{error}</p>
          <button className="edge-button" onClick={retry}>
            Retry
          </button>
          <Link href="/edge">Edit wallet</Link>
        </main>
      </>
    );
  if (!result)
    return (
      <>
        <Header />
        <main className="empty-state" role="status">
          {scan?.status === "blocked" || scan?.status === "failed"
            ? scan?.message || "Fresh analysis did not complete."
            : "Loading your Edge Print…"}
          <p>
            <Link href="/edge">Back to wallet input</Link>
          </p>
        </main>
      </>
    );
  const p = result.economicActions === 0
    ? {...result.performance, realizedPnl: null, unrealizedPnl: null, totalPnl: null}
    : result.performance;
  const visible=usefulFindings(result.findings);
  const positives=visible.filter(f=>f.status==='validated_positive_edge');
  const risks=visible.filter(f=>f.status==='validated_risk_pattern');
  const observations=visible.filter(f=>!f.status.startsWith('validated'));
  return (
    <>
      <Header label="Your Edge Print" />
      <div className="scan-wallet-strip"><span>{scan?.walletType==='solana'?'Solana':'EVM'} wallet analysis</span><code title={scan?.wallet}>{shortAddress(scan?.wallet||'')}</code><span>Last scan · {result.analyzedAt?new Date(result.analyzedAt).toLocaleString():'—'}</span></div>
      <main className="result-grid">
        <section className="result-overview">
          <p className="edge-label positive">
            Your Edge Print · {result.economicActions ?? "—"} actions ·{" "}
            {result.windowDays} days
          </p>
          <h1 className="result-title">
            {result.economicActions === 0 ? "Insufficient evidence · N=0." : p.realizedPnl === null ? "Your trading history." : <>Your {p.provenance === "estimated" ? "estimated " : ""}realized P&amp;L is <span className={Number(p.realizedPnl) >= 0 ? "positive" : "negative"}>{money(p.realizedPnl)}</span>.</>} {positives.length+risks.length ? `${positives.length+risks.length} patterns worth acting on.` : "Here’s what your habits show."}
          </h1>
          <p className="edge-muted">
            Analysis window · {date(result.windowStart)}–
            {date(result.windowEnd)} UTC
          </p>
          <Print findings={result.findings} pnl={p.realizedPnl} />
          <p className="small edge-muted">
            Analyzed {date(result.analyzedAt)} · model {result.modelVersion} ·
            rule {result.ruleVersion}. This is historical evidence, not a
            prediction.
          </p>
        </section>
        <section className="result-findings">
          <h2 className="result-section-heading positive">Do more of this</h2>
          <Findings items={positives}/>
          {risks.length>0 && <><h2 className="result-section-heading negative">Stop doing this</h2><Findings items={risks}/></>}
          {observations.length>0 && <><h2 className="result-section-heading">Habits to watch</h2><p className="small edge-muted">Early observations — more history is needed to confirm them.</p><Findings items={observations}/></>}
        </section>
        <section className="result-wide">
          <AgentDock actions={result.economicActions??0} scanId={scanId}/>
          {positionError && <p role="alert" className="edge-card empty-state">{positionError}</p>}
          {positions && (
            <PositionsChart
              positions={positions}
              window={
                result.windowStart && result.windowEnd
                  ? { start: result.windowStart, end: result.windowEnd }
                  : undefined
              }
            />
          )}
          <div className="section-heading">
            <h2 className="section-title">Position stories</h2>
            <span className="edge-muted small">
              Your buys and sells, at a glance
            </span>
          </div>
          {storyError && <p role="alert">{storyError}</p>}
          {stories.map((s) => (
            <details className="edge-card story" key={s.id}>
              <summary>
                {tokenLabel(s.symbol,s.tokenAddress||s.symbol)}{" "}
                <span className="edge-muted">
                  · {s.chain} · {s.currentBalanceStatus==='transferred_out'?'transferred out':s.state}
                </span>
              </summary>
              <p className="small edge-muted">{s.chapters.length} actions · {s.currentBalanceStatus==='transferred_out'?'Transferred out · no current balance':s.state==='open'?'Open in trading history':'Position closed'}{s.tokenAddress && ` · ${shortAddress(s.tokenAddress)}`}</p>
              <ol>
                {s.chapters.map((c) => (
                  <li key={c.id}>
                    <time>{date(c.at)}</time>
                    <h3>{c.description || human(c.action)}</h3>
                    {c.pattern && <p className="small edge-muted">{c.pattern} · {c.status?.startsWith('validated')?'Validated':'Observed'}</p>}
                  </li>
                ))}
              </ol>
            </details>
          ))}
          <details className="edge-card metrics">
            <summary>Performance · recorded window</summary>
            <p className="small warning">
              P&amp;L provenance: {human(p.provenance)}. Values marked estimated
              are not verified accounting totals. Verified FIFO totals cover priced, attributable inventory only; unknown acquisition costs and missing prices are excluded.
            </p>
            <dl>
              {[
                ["Realized P&L", money(p.realizedPnl)],
                ["Unrealized P&L", money(p.unrealizedPnl)],
                ["Total trading P&L", money(p.totalPnl)],
                ["Verified capital at period start", money(p.capitalAtStart)],
                ["Open-position cost basis", money(p.openCostBasis)],
                ["Historical win rate", pct(p.winRate)],
                ["Average completed-position result", pct(p.averageReturn)],
                ["Typical completed-position result", pct(p.medianReturn)],
                ["Average winner", pct(p.averageWinner)],
                ["Average loser", pct(p.averageLoser)],
                [
                  "Payoff ratio",
                  p.payoffRatio === null
                    ? "Unavailable"
                    : Number(p.payoffRatio).toFixed(2),
                ],
                [
                  "Profit factor",
                  p.profitFactor === null
                    ? "Unavailable"
                    : Number(p.profitFactor).toFixed(2),
                ],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd className="mono">{v}</dd>
                </div>
              ))}
            </dl>
          </details>
          <details className="edge-card metrics">
            <summary>Inventory exceptions</summary>
            <p>
              {result.exclusions.unattributedDisposals ?? "—"} unattributed
              inventory disposals
            </p>
            <p>
              {result.exclusions.partiallyAttributedDisposals ?? "—"} partially
              attributed disposals
            </p>
            <p className="small edge-muted">
              Excluded sale proceeds:{" "}
              {money(result.exclusions.excludedProceeds)}. Unmatched sales are
              not zero-cost profit. Missing exception values do not mean zero.
            </p>
          </details>
          <details className="edge-card evidence">
            <summary>Analysis details</summary>
            <p className="mono wallet-text">
              EVM: {result.identity.evmWallet || "Unavailable"}
              <br />
              Solana: {result.identity.solanaWallet || "Unavailable"}
            </p>
            <p>
              {result.closedPositions ?? "—"} closed ·{" "}
              {result.openPositions ?? "—"} open positions · analysis{" "}
              {result.analysisVersion || "unavailable"}
            </p>
            <p className="small edge-muted">Historical patterns only. Missing prices and unknown acquisition costs are excluded.</p>
          </details>
          {offset !== null && (
            <button
              className="edge-button"
              disabled={loading}
              onClick={() => void loadStories(offset)}
            >
              {loading ? "Loading stories…" : "Load more stories"}
            </button>
          )}

        </section>
      </main>
    </>
  );
}
