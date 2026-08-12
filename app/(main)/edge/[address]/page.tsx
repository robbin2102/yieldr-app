'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import styles from './edge.module.css';

interface ConfidenceBlock {
  tier: 'insufficient' | 'provisional' | 'high';
  trades: number;
  winRateCiLow: number | null;
  winRateCiHigh: number | null;
  pValueVsBaseline: number | null;
  recencyConsistent: boolean | null;
}

interface PortfolioStage {
  currentHoldingsUsd: number;
  realizedPnlUsd: number;
  winRate: number;
  tradeCount: number;
  roiPct: number;
  excludedTrades: { count: number; reason: string }[];
}

interface EntryBucket {
  conditionLabel: string;
  trades: number;
  winRate: number;
  expectancyUsd: number;
  totalPnlUsd: number;
  confidence: ConfidenceBlock;
}

interface EntryStage {
  verdict: string;
  primaryDriver: string;
  expectancyUsd: number;
  conditionBreakdown: EntryBucket[];
  negativeFindings: string[];
  confidence: ConfidenceBlock;
}

interface ExitBucket {
  conditionLabel: 'scaled_out' | 'sold_all_at_once' | 'held_into_loss_after_being_up';
  trades: number;
  frequencyPct: number;
  peakCaptureAvg: number;
  expectancyUsd: number;
  confidence: ConfidenceBlock;
}

interface ExitStage {
  verdict: string;
  primaryDriver: string;
  expectancyUsd: number;
  peakCapturePct: number;
  roundTripRatePct: number;
  lossSideExitSpeedSeconds: number;
  winnerHoldTimeSeconds: number;
  conditionBreakdown: ExitBucket[];
  negativeFindings: string[];
  confidence: ConfidenceBlock;
}

interface SizingStage {
  verdict: string;
  primaryDriver: string;
  expectancyUsd: number;
  avgSizeWinnersUsd: number;
  avgSizeLosersUsd: number;
  convictionRatio: number;
  sizeCoV: number;
  sizeSpectrumLabel: 'erratic' | 'mixed' | 'disciplined';
  winnerAddOnRatePct: number;
  lossSideSizeCutSpeedSeconds: number | null;
  addAfterLossRatioPct: number;
  scaleInShapeLabel: 'single_shot' | 'scaled_in' | 'mixed';
  negativeFindings: string[];
  confidence: ConfidenceBlock;
}

interface CompositeStage {
  edgeScore: number;
  confidence: ConfidenceBlock;
}

type FeedItem =
  | { kind: 'log'; tag: 'SCAN' | 'MATCH' | 'FLAG' | 'OK'; text: string }
  | { kind: 'bubble'; text: string }
  | { kind: 'user'; text: string };

const CONFIDENCE_COPY: Record<ConfidenceBlock['tier'], string> = {
  insufficient: 'still gathering data',
  provisional: 'early signal',
  high: 'trust this',
};

function confidenceLabel(c: ConfidenceBlock): string {
  return `${c.trades} trades · ${CONFIDENCE_COPY[c.tier]}`;
}

function fmtUsd(n: number): string {
  const sign = n < 0 ? '-' : '+';
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function fmtPct(n: number): string {
  return `${n.toFixed(0)}%`;
}

const EXIT_STYLE_LABEL: Record<ExitBucket['conditionLabel'], string> = {
  scaled_out: 'Sold in pieces',
  sold_all_at_once: 'Sold all at once',
  held_into_loss_after_being_up: 'Held too long',
};

const EXIT_STYLE_COLOR: Record<ExitBucket['conditionLabel'], string> = {
  scaled_out: 'var(--win)',
  sold_all_at_once: 'var(--ink-3)',
  held_into_loss_after_being_up: 'var(--loss)',
};

export default function EdgePage() {
  const params = useParams<{ address: string }>();
  const address = params.address;

  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [portfolio, setPortfolio] = useState<PortfolioStage | null>(null);
  const [entry, setEntry] = useState<EntryStage | null>(null);
  const [exit, setExit] = useState<ExitStage | null>(null);
  const [sizing, setSizing] = useState<SizingStage | null>(null);
  const [composite, setComposite] = useState<CompositeStage | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  const pushFeed = (item: FeedItem) => setFeed((f) => [...f, item]);

  useEffect(() => {
    if (started.current || !address) return;
    started.current = true;
    runAnalysis();
  }, [address]);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' });
  }, [feed]);

  async function runAnalysis() {
    setStatus('running');
    pushFeed({ kind: 'log', tag: 'SCAN', text: `Reading ${address.slice(0, 6)}...${address.slice(-4)} on Base + HOOD...` });

    try {
      const res = await fetch('/api/edge/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: address }),
      });
      if (!res.body) throw new Error('no response stream');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          handleEvent(JSON.parse(line));
        }
      }
      setStatus('done');
    } catch (err) {
      console.error(err);
      setStatus('error');
      pushFeed({ kind: 'bubble', text: "Couldn't complete the analysis - the data layer hit an error. Try Re-run in a moment." });
    }
  }

  function handleEvent(evt: { type: string; data: any }) {
    switch (evt.type) {
      case 'portfolio': {
        const p = evt.data as PortfolioStage;
        setPortfolio(p);
        pushFeed({ kind: 'log', tag: 'MATCH', text: `Realized ${fmtUsd(p.realizedPnlUsd)}, ${fmtPct(p.winRate * 100)} win rate, ${p.tradeCount} closed trades.` });
        if (p.excludedTrades.length > 0) {
          const total = p.excludedTrades.reduce((s, e) => s + e.count, 0);
          pushFeed({ kind: 'log', tag: 'FLAG', text: `${total} trade(s) excluded: ${p.excludedTrades.map((e) => e.reason).join('; ')}` });
        }
        pushFeed({
          kind: 'bubble',
          text: `Your wallet holds $${p.currentHoldingsUsd.toLocaleString()} right now. Across ${p.tradeCount} closed trades you've realized ${fmtUsd(p.realizedPnlUsd)} (${fmtPct(p.roiPct)} ROI). Now let's find out why.`,
        });
        break;
      }
      case 'entry': {
        const e = evt.data as EntryStage;
        setEntry(e);
        pushFeed({ kind: 'log', tag: 'SCAN', text: `Discovered ${e.conditionBreakdown.length} distinct entry setups...` });
        const best = e.conditionBreakdown[0];
        if (best) {
          pushFeed({
            kind: 'bubble',
            text: `Entry: your biggest ${best.expectancyUsd >= 0 ? 'edge' : 'leak'} is "${best.conditionLabel}" - ${best.trades} trades, ${fmtPct(best.winRate * 100)} win rate, ${fmtUsd(best.expectancyUsd)}/trade expectancy (${confidenceLabel(best.confidence)}).`,
          });
        }
        break;
      }
      case 'exit': {
        const e = evt.data as ExitStage;
        setExit(e);
        pushFeed({ kind: 'log', tag: 'MATCH', text: `Peak capture ${fmtPct(e.peakCapturePct)}, round-trip rate ${fmtPct(e.roundTripRatePct)}.` });
        pushFeed({
          kind: 'bubble',
          text: `Exit: you capture ${fmtPct(e.peakCapturePct)} of the average move before selling. ${e.primaryDriver}.`,
        });
        break;
      }
      case 'sizing': {
        const s = evt.data as SizingStage;
        setSizing(s);
        pushFeed({
          kind: 'bubble',
          text: `Sizing: ${s.primaryDriver}. Add-after-loss (averaging down) ratio: ${fmtPct(s.addAfterLossRatioPct)}.`,
        });
        break;
      }
      case 'composite': {
        const c = evt.data as CompositeStage;
        setComposite(c);
        pushFeed({ kind: 'log', tag: 'OK', text: `Edge score ${c.edgeScore}/100 (${c.confidence.tier}).` });
        pushFeed({
          kind: 'bubble',
          text: `Putting it together: your Edge Score is ${c.edgeScore}/100. Confidence: ${confidenceLabel(c.confidence)}.`,
        });
        break;
      }
      case 'error': {
        pushFeed({ kind: 'bubble', text: `Hit a snag: ${evt.data?.message ?? 'unknown error'}.` });
        break;
      }
    }
  }

  async function sendChat() {
    const text = chatInput.trim();
    if (!text || chatBusy) return;
    setChatInput('');
    pushFeed({ kind: 'user', text });
    setChatBusy(true);
    try {
      const res = await fetch('/api/edge/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: address, message: text }),
      });
      const data = await res.json();
      pushFeed({ kind: 'bubble', text: data.reply });
    } finally {
      setChatBusy(false);
    }
  }

  const badge = !composite ? 'ANALYZING' : composite.edgeScore >= 65 ? 'STRONG EDGE' : composite.edgeScore >= 40 ? 'POSSIBLE EDGE' : 'NEEDS WORK';

  return (
    <div className={styles.page}>
      <div className={styles.topbar}>
        <div>
          <div className={styles.tbName}>
            {address ? `${address.slice(0, 6)}...${address.slice(-4)}` : ''}
          </div>
          <div className={styles.tbTags}>
            <span className={styles.tbTag}>Quant Agent · Edge</span>
            <span className={styles.tbTag}>Base · HOOD</span>
          </div>
        </div>
        <div className={styles.tbRight}>
          <div className={styles.tbPill}>
            <div className={styles.k}>Realized P&amp;L</div>
            <div className={`${styles.v} ${styles.num} ${portfolio && portfolio.realizedPnlUsd >= 0 ? styles.win : styles.loss}`}>
              {portfolio ? fmtUsd(portfolio.realizedPnlUsd) : '$--'}
            </div>
          </div>
          <div className={styles.tbPill}>
            <div className={styles.k}>ROI</div>
            <div className={`${styles.v} ${styles.num} ${portfolio && portfolio.roiPct >= 0 ? styles.win : styles.loss}`}>
              {portfolio ? fmtPct(portfolio.roiPct) : '--'}
            </div>
          </div>
          <div className={styles.tbPill}>
            <div className={styles.k}>Trades</div>
            <div className={`${styles.v} ${styles.num}`}>{portfolio ? portfolio.tradeCount : '--'}</div>
          </div>
        </div>
      </div>

      <div className={styles.layout}>
        <div className={styles.center}>
          <div className={styles.hero}>
            <div className={styles.heroRow}>
              <div>
                <div className={styles.heroFigure}>
                  <div className={styles.heroNum}>{composite ? composite.edgeScore : '--'}</div>
                  <div className={styles.heroMax}>/ 100</div>
                  <div className={styles.heroBadge}>{badge}</div>
                </div>
                <div className={styles.heroCohort}>
                  {composite ? `Confidence: ${confidenceLabel(composite.confidence)}` : 'Reconstructing trades from live chain data...'}
                </div>
              </div>
            </div>
            {portfolio && (
              <div className={styles.heroExpectancy}>
                Wallet expectancy: {fmtUsd(portfolio.realizedPnlUsd / Math.max(1, portfolio.tradeCount))}/trade
              </div>
            )}
            <div className={styles.heroWeights}>
              <div className={styles.hwItem}><span className={styles.hwDot} style={{ background: 'var(--win)' }} />Exit — 40%</div>
              <div className={styles.hwItem}><span className={styles.hwDot} style={{ background: 'var(--warn)' }} />Sizing — 35%</div>
              <div className={styles.hwItem}><span className={styles.hwDot} style={{ background: 'var(--agent)' }} />Entry — 25%</div>
            </div>
          </div>

          <div className={styles.slbl}>Entry — When You Buy</div>
          <EntryCard entry={entry} />

          <div className={styles.slbl}>Exit — When You Sell</div>
          <ExitCard exit={exit} />

          <div className={styles.slbl}>Sizing — How Much You Bet</div>
          <SizingCard sizing={sizing} />

          <div className={styles.footer}>
            <div className={styles.tbTag}>{status === 'running' ? 'Analysis in progress...' : status === 'done' ? 'Analysis complete' : ''}</div>
            <button className={styles.btnF} onClick={runAnalysis}>Re-run</button>
          </div>
        </div>

        <div className={styles.aside}>
          <div className={styles.agHd}>
            <div className={styles.agAvatar}>🤖</div>
            <div>
              <div className={styles.agName}>Quant Agent</div>
              <div className={styles.agStatus}>
                <span className={`${styles.dotLive} ${status === 'done' || status === 'error' ? styles.dotLiveIdle : ''}`} />
                {status === 'running' ? 'Analyzing...' : status === 'done' ? 'Idle' : status === 'error' ? 'Error' : 'Waiting...'}
              </div>
            </div>
          </div>
          <div className={styles.agFeed} ref={feedRef}>
            {feed.map((item, i) => <FeedRow key={i} item={item} />)}
          </div>
          <div className={styles.chatbar}>
            <input
              className={styles.chatin}
              placeholder="Ask about a pattern or metric..."
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendChat()}
            />
            <button className={styles.chatsend} onClick={sendChat} disabled={chatBusy || !chatInput.trim()}>→</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function FeedRow({ item }: { item: FeedItem }) {
  if (item.kind === 'log') {
    const tagClass = { SCAN: styles.tagScan, MATCH: styles.tagMatch, FLAG: styles.tagFlag, OK: styles.tagOk }[item.tag];
    return (
      <div className={styles.syslog}>
        <span className={`${styles.tag} ${tagClass}`}>{item.tag}</span>
        {item.text}
      </div>
    );
  }
  if (item.kind === 'user') {
    return (
      <div className={styles.uRow}>
        <div className={styles.uBubble}>{item.text}</div>
      </div>
    );
  }
  return <div className={styles.bubble}>{item.text}</div>;
}

function EntryCard({ entry }: { entry: EntryStage | null }) {
  return (
    <div className={`${styles.cat} ${!entry ? styles.catPending : ''}`}>
      <div className={styles.catHd}>
        <div className={styles.catHdL}>
          <div className={styles.catIc}>🎯</div>
          <div>
            <div className={styles.catName}>Entry</div>
            <div className={styles.catSub}>Every distinguishable setup found in your buys, ranked by impact</div>
          </div>
        </div>
        <div className={styles.catHdR}>
          <span className={styles.catWeight}>25% of grade</span>
          <span className={`${styles.catGrade} ${entry ? gradeClass(entry.verdict) : ''}`}>{entry ? entry.verdict.replace('_', ' ') : '···'}</span>
        </div>
      </div>
      <div className={styles.catBody}>
        {entry?.conditionBreakdown.map((b) => (
          <div key={b.conditionLabel} className={`${styles.typeRow} ${b.expectancyUsd >= 0 ? styles.typeRowWin : styles.typeRowLoss}`}>
            <div className={styles.typeLabel}>{b.conditionLabel}</div>
            <div className={styles.typeTrack}>
              <div
                className={styles.typeFill}
                style={{ width: `${Math.round(b.winRate * 100)}%`, background: b.expectancyUsd >= 0 ? 'var(--win)' : 'var(--loss)' }}
              />
            </div>
            <div className={styles.typeMeta}>
              <span>{fmtPct(b.winRate * 100)} win · {b.trades} trades</span>
              <span className={`${styles.amt} ${b.expectancyUsd >= 0 ? styles.win : styles.loss}`}>{fmtUsd(b.expectancyUsd)}/trade</span>
              <span className={styles.confTag}>{confidenceLabel(b.confidence)}</span>
            </div>
          </div>
        ))}
        {entry && entry.negativeFindings.length > 0 && (
          <div className={`${styles.pattern} ${styles.patternLoss}`}>
            <div className={styles.patternTxt}>
              <b>Negative findings:</b> {entry.negativeFindings.join(' · ')}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ExitCard({ exit }: { exit: ExitStage | null }) {
  return (
    <div className={`${styles.cat} ${!exit ? styles.catPending : ''}`}>
      <div className={styles.catHd}>
        <div className={styles.catHdL}>
          <div className={styles.catIc}>💰</div>
          <div>
            <div className={styles.catName}>Exit</div>
            <div className={styles.catSub}>How much of the move you actually capture</div>
          </div>
        </div>
        <div className={styles.catHdR}>
          <span className={styles.catWeight}>40% of grade</span>
          <span className={`${styles.catGrade} ${exit ? gradeClass(exit.verdict) : ''}`}>{exit ? exit.verdict.replace('_', ' ') : '···'}</span>
        </div>
      </div>
      <div className={styles.catBody}>
        <div className={styles.capWrap}>
          <div className={styles.capLblRow}><span>Peak captured</span><span>{exit ? fmtPct(exit.peakCapturePct) : '--'}</span></div>
          <div className={styles.capTrack}><div className={styles.capFill} style={{ width: `${exit?.peakCapturePct ?? 0}%` }} /></div>
        </div>
        <div className={styles.capWrap}>
          <div className={styles.capLblRow}><span>Round-trip rate</span><span>{exit ? fmtPct(exit.roundTripRatePct) : '--'}</span></div>
          <div className={styles.capTrack}><div className={styles.capFill} style={{ width: `${exit?.roundTripRatePct ?? 0}%`, background: 'var(--warn)' }} /></div>
        </div>

        {exit && (
          <>
            <div className={styles.segBar}>
              {exit.conditionBreakdown.map((b) => (
                <div key={b.conditionLabel} className={styles.seg} style={{ width: `${b.frequencyPct}%`, background: EXIT_STYLE_COLOR[b.conditionLabel] }} />
              ))}
            </div>
            <div className={styles.segLegend}>
              {exit.conditionBreakdown.map((b) => (
                <div key={b.conditionLabel} className={styles.segItem}>
                  <span className={styles.dot} style={{ background: EXIT_STYLE_COLOR[b.conditionLabel] }} />
                  {EXIT_STYLE_LABEL[b.conditionLabel]} — {fmtPct(b.frequencyPct)} · capture {fmtPct(b.peakCaptureAvg)} · {fmtUsd(b.expectancyUsd)}/trade
                  <span className={styles.idot}>i<span className={styles.pop}>{confidenceLabel(b.confidence)}</span></span>
                </div>
              ))}
            </div>
            <div className={styles.statGrid}>
              <div className={styles.statTile}><div className={styles.lbl}>Winner hold time</div><div className={styles.val}>{fmtDuration(exit.winnerHoldTimeSeconds)}</div></div>
              <div className={styles.statTile}><div className={styles.lbl}>Loss-side exit speed</div><div className={styles.val}>{fmtDuration(exit.lossSideExitSpeedSeconds)}</div></div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SizingCard({ sizing }: { sizing: SizingStage | null }) {
  return (
    <div className={`${styles.cat} ${!sizing ? styles.catPending : ''}`}>
      <div className={styles.catHd}>
        <div className={styles.catHdL}>
          <div className={styles.catIc}>⚖️</div>
          <div>
            <div className={styles.catName}>Sizing</div>
            <div className={styles.catSub}>Whether your conviction matches your outcomes</div>
          </div>
        </div>
        <div className={styles.catHdR}>
          <span className={styles.catWeight}>35% of grade</span>
          <span className={`${styles.catGrade} ${sizing ? gradeClass(sizing.verdict) : ''}`}>{sizing ? sizing.verdict.replace('_', ' ') : '···'}</span>
        </div>
      </div>
      <div className={styles.catBody}>
        {sizing && (
          <>
            <div className={styles.ladder}>
              <div className={styles.ladderRow}>
                <div className={styles.ladderLabel}>On winners</div>
                <div className={styles.ladderTrack}><div className={styles.ladderFill} style={{ width: '100%', background: 'var(--win)' }}><span>${sizing.avgSizeWinnersUsd.toFixed(0)}</span></div></div>
              </div>
              <div className={styles.ladderRow}>
                <div className={styles.ladderLabel}>On losers</div>
                <div className={styles.ladderTrack}>
                  <div
                    className={styles.ladderFill}
                    style={{ width: `${Math.min(100, (sizing.avgSizeLosersUsd / Math.max(1, sizing.avgSizeWinnersUsd)) * 100)}%`, background: 'var(--loss)' }}
                  >
                    <span>${sizing.avgSizeLosersUsd.toFixed(0)}</span>
                  </div>
                </div>
              </div>
            </div>
            <div className={styles.ladderRatio}>
              {sizing.convictionRatio === Infinity ? 'All-in on winners only' : `${sizing.convictionRatio.toFixed(1)}x more sized on winners`}
              {' '}· CoV {sizing.sizeCoV.toFixed(2)} ({sizing.sizeSpectrumLabel})
            </div>
            <div className={styles.statGrid}>
              <div className={styles.statTile}><div className={styles.lbl}>Winner add-on rate</div><div className={styles.val}>{fmtPct(sizing.winnerAddOnRatePct)}</div></div>
              <div className={styles.statTile}><div className={styles.lbl}>Add-after-loss ratio</div><div className={styles.val}>{fmtPct(sizing.addAfterLossRatioPct)}</div></div>
              <div className={styles.statTile}><div className={styles.lbl}>Loss-side cut speed</div><div className={styles.val}>{sizing.lossSideSizeCutSpeedSeconds !== null ? fmtDuration(sizing.lossSideSizeCutSpeedSeconds) : 'n/a'}</div></div>
              <div className={styles.statTile}><div className={styles.lbl}>Scale-in shape</div><div className={styles.val}>{sizing.scaleInShapeLabel.replace('_', ' ')}</div></div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function gradeClass(verdict: string): string {
  if (verdict === 'strong_edge') return styles.catGradeWin;
  if (verdict === 'negative_edge') return styles.catGradeLoss;
  return '';
}

function fmtDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return 'n/a';
  const hours = seconds / 3600;
  if (hours < 1) return `${Math.round(seconds / 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}
