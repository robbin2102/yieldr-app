import { OPENAI_MODEL, EDGE_REASONING_MAX_WORDS } from './config';
import type { EdgeReport } from './types';
import type { EdgeReasoningVerdict } from '@/models/EdgeReasoningLog';

export interface EdgeReasoningResult {
  verdict: EdgeReasoningVerdict;
  reasoning: string;
}

const SYSTEM_PROMPT = `You are a blunt, data-driven trading coach reviewing an on-chain crypto trader's wallet.
You are given wallet-data-only statistics reconstructed purely from the trader's own buy/sell transactions -
no market/coin data (no liquidity, no token age, no price charts). The stats cover three areas: how they enter
trades, how they exit trades, and how they size positions - plus an edge-decay trend comparing this run to the
wallet's own recent history.

Decide whether this trader currently shows a demonstrable, repeatable edge. Ground every claim in the numbers
you were given - do not invent details. If the sample size is too small or the signals are mixed, say so plainly
instead of forcing a verdict either way.

Write for a degen crypto trader: direct, no fluff, no unexplained jargon. Reply in under ${EDGE_REASONING_MAX_WORDS} words total.

Format your reply as:
VERDICT: has_edge | no_edge | insufficient_data

<reasoning paragraph(s), plain language, under ${EDGE_REASONING_MAX_WORDS} words>`;

function buildUserPrompt(report: EdgeReport): string {
  const p = report.performance;
  const e = report.categories.entry;
  const x = report.categories.exit;
  const s = report.categories.sizing;
  const convictionLabel = s.convictionRatio === Infinity ? 'infinite (never sized into a loser)' : `${s.convictionRatio.toFixed(2)}x`;

  const lines: string[] = [
    `Trades analyzed: ${p.tradeCount}`,
    `Realized PnL: $${p.realizedPnlUsd.toFixed(2)}`,
    `Win rate: ${(p.winRate * 100).toFixed(1)}%`,
    `Expectancy per trade: $${p.expectancyUsd.toFixed(2)}`,
    `ROI: ${p.roiPct.toFixed(1)}%`,
    `Edge score: ${report.edgeScore}/100 (confidence: ${report.confidence.tier}, n=${report.confidence.trades})`,
    '',
    `ENTRY - verdict: ${e.verdict}, primary driver: ${e.primaryDriver}`,
    `EXIT - verdict: ${x.verdict}, primary driver: ${x.primaryDriver}, avg peak capture: ${x.peakCapturePct.toFixed(1)}%, round-trip rate: ${x.roundTripRatePct.toFixed(1)}%`,
    `SIZING - verdict: ${s.verdict}, primary driver: ${s.primaryDriver}, conviction ratio (size on winners vs losers): ${convictionLabel}, size pattern: ${s.sizeSpectrumLabel}`,
    '',
    'TOP STRENGTHS:',
    ...(report.topStrengths.length ? report.topStrengths.map((f) => `- ${f.label}: ${f.detail}`) : ['- none found yet']),
    'TOP WEAKNESSES:',
    ...(report.topWeaknesses.length ? report.topWeaknesses.map((f) => `- ${f.label}: ${f.detail}`) : ['- none found yet']),
    '',
    `EDGE DECAY (trend vs this wallet's own recent runs): ${report.edgeDecay.status}` +
      (report.edgeDecay.edgeScoreDelta !== null
        ? ` (edge score change vs trailing average: ${report.edgeDecay.edgeScoreDelta >= 0 ? '+' : ''}${report.edgeDecay.edgeScoreDelta.toFixed(1)})`
        : ' (not enough analysis history yet to say)'),
  ];
  return lines.join('\n');
}

function parseReasoningResponse(raw: string): EdgeReasoningResult {
  const match = raw.match(/^VERDICT:\s*(has_edge|no_edge|insufficient_data)\s*\n+([\s\S]*)$/i);
  const verdict = (match?.[1]?.toLowerCase() as EdgeReasoningVerdict) ?? 'insufficient_data';
  let reasoning = (match?.[2] ?? raw).trim();

  const words = reasoning.split(/\s+/).filter(Boolean);
  if (words.length > EDGE_REASONING_MAX_WORDS) {
    reasoning = words.slice(0, EDGE_REASONING_MAX_WORDS).join(' ') + '...';
  }

  return { verdict, reasoning };
}

/**
 * Calls OpenAI to reason over a full EdgeReport (wallet-data-only metrics,
 * top findings, edge decay trend) and produce a <=300-word plain-language
 * verdict on whether the trader currently has an edge. Plain fetch, no SDK -
 * this is one REST call, not worth a new dependency.
 */
export async function generateEdgeReasoning(report: EdgeReport): Promise<EdgeReasoningResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.3,
      max_tokens: 600,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(report) },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI request failed: ${res.status} ${body.slice(0, 300)}`);
  }

  const json = await res.json();
  const raw: string = json.choices?.[0]?.message?.content ?? '';
  if (!raw) throw new Error('OpenAI returned an empty reasoning response');

  return parseReasoningResponse(raw);
}
