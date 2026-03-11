/**
 * AI Hedge Fund — Edge Discovery Batch (Part 4)
 *
 * Reads ahf-alphaTraders where llm_analyzed_at is null.
 * Calls Claude to identify each trader's specific edge.
 * Updates ahf-alphaTraders with LLM outputs.
 *
 * Usage:
 *   npx tsx scripts/ai-hedge-fund/edge-discovery-batch.ts
 *   npx tsx scripts/ai-hedge-fund/edge-discovery-batch.ts --limit=10
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient, Db } from 'mongodb';
import Anthropic from '@anthropic-ai/sdk';

// ── Env loading ───────────────────────────────────────────────────────────────
const envLocations = [
  path.resolve(process.cwd(), '.env.local'),
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'services/.private/poly-agent/.env.polyagent'),
];
for (const envPath of envLocations) {
  const result = dotenv.config({ path: envPath });
  if (!result.error && process.env.MONGODB_URI) break;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface CategoryBreakdown {
  category: string;
  sub_league?: string | null;
  closed_positions: number;
  wins: number;
  losses: number;
  win_rate: number;
  total_pnl: number;
  pnl_share: number;
  avg_entry_price: number;
}

interface MarketTitle {
  title: string;
  won: boolean;
  total_pnl: number;
  times_entered: number;
  avg_entry_price: number;
}

interface AlphaTrader {
  wallet: string;
  display_name?: string | null;
  pseudonym?: string | null;
  win_rate: number;
  win_rate_sample_size: number;
  profit_factor: number;
  roce_30d: number;
  pnl_7d: number;
  pnl_30d: number;
  expected_win_rate: number;
  edge_magnitude: number;
  p_value: number;
  rank_score: number;
  edge_confidence: string;
  insider_probability: string;
  insider_score: number;
  insider_signals_fired: string[];
  last_active_days_ago?: number | null;
  specialty?: string;
  category_breakdown?: CategoryBreakdown[];
  market_titles_summary?: MarketTitle[];
  llm_analyzed_at?: Date | null;
}

interface LlmOutput {
  edge_type: string;
  edge_hypothesis: string;
  strength_markets: string[];
  weakness_markets: string[];
  price_range_min: number;
  price_range_max: number;
  sustainability: string;
  follow_rules: string;
}

export interface EdgeDiscoveryResult {
  processed: number;
  succeeded: number;
  failed: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function parseLimitArg(): number | null {
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--limit=(\d+)$/);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

function buildPrompt(trader: AlphaTrader): string {
  const name =
    trader.display_name || trader.pseudonym || trader.wallet.slice(0, 8);

  const categoryLines = (trader.category_breakdown ?? [])
    .slice(0, 10)
    .map((c: CategoryBreakdown) => {
      const league = c.sub_league ? `/${c.sub_league}` : '';
      return (
        `${c.category}${league}: ` +
        `${c.closed_positions} positions, ${c.win_rate.toFixed(0)}% win rate, ` +
        `$${c.total_pnl.toFixed(0)} PnL (${c.pnl_share.toFixed(0)}% of total), ` +
        `avg entry ${c.avg_entry_price.toFixed(2)}`
      );
    })
    .join('\n');

  const marketLines = (trader.market_titles_summary ?? [])
    .slice(0, 15)
    .map((m: MarketTitle) => {
      const sign = m.won ? '+' : '-';
      return (
        `${m.won ? 'WON' : 'LOST'} ${sign}$${Math.abs(m.total_pnl).toFixed(0)}: ` +
        `${m.title.slice(0, 55)} ` +
        `(${m.times_entered}x entries, avg entry ${m.avg_entry_price.toFixed(2)})`
      );
    })
    .join('\n');

  const insiderLine =
    trader.insider_signals_fired.length > 0
      ? `Signals fired: ${trader.insider_signals_fired.join(', ')}`
      : 'No insider signals';

  return (
    `TRADER: ${name}\n` +
    `Active: ${trader.last_active_days_ago ?? 'unknown'}d ago | Sample: ${trader.win_rate_sample_size} positions\n\n` +
    `STATISTICAL EDGE:\n` +
    `Win rate: ${trader.win_rate.toFixed(1)}% vs expected ${(trader.expected_win_rate * 100).toFixed(1)}%\n` +
    `Edge magnitude: +${(trader.edge_magnitude * 100).toFixed(1)}pp above market implied probability\n` +
    `Confidence: ${trader.edge_confidence} (p=${trader.p_value.toFixed(3)}, n=${trader.win_rate_sample_size})\n` +
    `Profit factor: ${trader.profit_factor.toFixed(3)} | ROCE 30d: ${trader.roce_30d.toFixed(1)}%\n` +
    `PnL 30d: $${trader.pnl_30d.toFixed(0)} | PnL 7d: $${trader.pnl_7d.toFixed(0)}\n\n` +
    `MARKET PERFORMANCE (by category/sub-league, sorted by |PnL|):\n` +
    `${categoryLines}\n\n` +
    `INSIDER SIGNALS: probability=${trader.insider_probability} score=${trader.insider_score}\n` +
    `${insiderLine}\n\n` +
    `TOP MARKETS BY |PnL| (from ${trader.win_rate_sample_size} closed positions):\n` +
    `${marketLines}\n\n` +
    `Return ONLY this JSON:\n` +
    `{\n` +
    `  "edge_type": "statistical_model|domain_expertise|insider_information|value_betting|team_specialist|unclear",\n` +
    `  "edge_hypothesis": "2 sentences max. What specifically do they know or do better than the market?",\n` +
    `  "strength_markets": ["specific strings e.g. 'Soccer/La Liga/underdog win markets'"],\n` +
    `  "weakness_markets": ["specific strings to avoid"],\n` +
    `  "price_range_min": 0.00,\n` +
    `  "price_range_max": 1.00,\n` +
    `  "sustainability": "high|medium|low",\n` +
    `  "follow_rules": "1-2 sentences: when to enter, any timing or execution notes specific to this trader"\n` +
    `}`
  );
}

// ── Core logic (exported for pipeline use) ────────────────────────────────────

export async function runEdgeDiscovery(
  db: Db,
  limit?: number
): Promise<EdgeDiscoveryResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set in environment');
  }

  const anthropic = new Anthropic({ apiKey });

  // Load unanalyzed traders, sorted by rank_score DESC
  const query: Record<string, unknown> = { llm_analyzed_at: null };
  let cursor = db
    .collection<AlphaTrader>('ahf-alphaTraders')
    .find(query)
    .sort({ rank_score: -1 });

  if (limit) cursor = cursor.limit(limit);
  const traders = await cursor.toArray();

  const total = traders.length;
  console.log(`  Found ${total} traders pending LLM analysis`);

  if (total === 0) {
    console.log('  Nothing to process.');
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  let succeeded = 0;
  let failed = 0;
  const col = db.collection('ahf-alphaTraders');

  for (let i = 0; i < traders.length; i++) {
    const trader = traders[i];
    const walletShort = trader.wallet.slice(0, 10);
    const position = `[${i + 1}/${total}]`;

    process.stdout.write(`  ${position} ${walletShort} ... `);

    try {
      const userPrompt = buildPrompt(trader);

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 1500,
        temperature: 0,
        system:
          'You are an expert prediction market analyst at an AI hedge fund. ' +
          'Analyze the trader profile and identify their specific edge with precision. ' +
          'Be specific about which markets, conditions, and price ranges this edge applies to. ' +
          'Return ONLY valid JSON. No explanation, no markdown, no other text.',
        messages: [{ role: 'user', content: userPrompt }],
      });

      const rawText =
        response.content[0].type === 'text' ? response.content[0].text : '';

      let parsed: LlmOutput;
      try {
        // Strip any accidental markdown fences
        const cleaned = rawText
          .replace(/^```json\s*/i, '')
          .replace(/^```\s*/i, '')
          .replace(/\s*```$/i, '')
          .trim();
        parsed = JSON.parse(cleaned) as LlmOutput;
      } catch {
        // JSON parse failure — store as unclear
        await col.updateOne(
          { wallet: trader.wallet },
          {
            $set: {
              edge_type: 'unclear',
              edge_hypothesis: rawText.slice(0, 500),
              llm_analyzed_at: new Date(),
            },
          }
        );
        console.log(`⚠ JSON parse failed — stored as unclear`);
        failed++;

        if (i < traders.length - 1) await sleep(3000);
        continue;
      }

      await col.updateOne(
        { wallet: trader.wallet },
        {
          $set: {
            edge_type:        parsed.edge_type,
            edge_hypothesis:  parsed.edge_hypothesis,
            strength_markets: parsed.strength_markets,
            weakness_markets: parsed.weakness_markets,
            price_range_min:  parsed.price_range_min,
            price_range_max:  parsed.price_range_max,
            sustainability:   parsed.sustainability,
            follow_rules:     parsed.follow_rules,
            llm_analyzed_at:  new Date(),
          },
        }
      );

      console.log(
        `✓ [${parsed.edge_type}] ${(parsed.edge_hypothesis ?? '').slice(0, 80)}...`
      );
      succeeded++;

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`✗ API error — ${msg}`);
      failed++;
      // Do not update document on API error, continue to next trader
    }

    if (i < traders.length - 1) await sleep(3000);
  }

  console.log(`\n  LLM analysis complete: ${succeeded} succeeded, ${failed} failed`);
  return { processed: total, succeeded, failed };
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function extractDbName(uri: string): string {
  try {
    const url = new URL(uri);
    return url.pathname.replace('/', '') || 'polymarket-test';
  } catch {
    return uri.match(/\/([^/?]+)(\?|$)/)?.[1] ?? 'polymarket-test';
  }
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('ERROR: MONGODB_URI not set');
    process.exit(1);
  }

  const limit = parseLimitArg() ?? undefined;

  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(extractDbName(mongoUri));
  console.log(`Connected → db: ${extractDbName(mongoUri)}`);
  if (limit !== undefined) console.log(`Limit: ${limit} traders`);
  console.log('');

  try {
    await runEdgeDiscovery(db, limit);
  } finally {
    await client.close();
  }
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
