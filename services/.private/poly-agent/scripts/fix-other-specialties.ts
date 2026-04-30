/**
 * fix-other-specialties.ts
 *
 * Fixes traders stuck with specialty='Other' in ahf-edgeRankedTraders.
 *
 * Step 1 — category_breakdown inference:
 *   Look at the trader's polymarket-traderProfiles.category_breakdown.
 *   If any non-'Other' category has positive total_pnl and >= MIN_TRADES positions,
 *   use the top one by total_pnl as the specialty.
 *
 * Step 2 — LLM classification (xAI Grok or Anthropic):
 *   For traders where step 1 didn't resolve, collect their
 *   market_titles_summary (actual market question titles) and send batches
 *   to the LLM. It classifies each trader into one of the known categories
 *   or suggests a new one.
 *
 * Updates ahf-edgeRankedTraders.specialty + polymarket-traderProfiles.specialty.
 *
 * Usage:
 *   npx tsx scripts/fix-other-specialties.ts
 *   npx tsx scripts/fix-other-specialties.ts --dry-run     # preview only, no writes
 *   npx tsx scripts/fix-other-specialties.ts --skip-llm    # step 1 only
 *
 * Requires:
 *   MONGODB_URI
 *   XAI_API_KEY   (or ANTHROPIC_API_KEY — see LLM_PROVIDER below)
 */

import dotenv from 'dotenv';
import path from 'path';
import { MongoClient } from 'mongodb';

const envLocations = [
  // __dirname-based: works from any cwd (script lives at <root>/scripts/)
  path.resolve(__dirname, '../env.polyagent'),
  path.resolve(__dirname, '../.env.polyagent'),
  path.resolve(__dirname, '../.env.local'),
  path.resolve(__dirname, '../.env'),
  // cwd-based fallbacks (run from repo root)
  path.resolve(process.cwd(), '.env.local'),
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'services/.private/poly-agent/env.polyagent'),
];
for (const e of envLocations) {
  const r = dotenv.config({ path: e });
  if (!r.error && process.env.MONGODB_URI) break;
}

// ── Config ────────────────────────────────────────────────────────────────────

const DRY_RUN  = process.argv.includes('--dry-run');
const SKIP_LLM = process.argv.includes('--skip-llm');

// Category breakdown: minimum closed positions to trust a non-Other category
const MIN_TRADES_FOR_BREAKDOWN_SPECIALTY = 5;

// LLM provider: 'xai' (Grok) or 'anthropic' (Claude Haiku)
const LLM_PROVIDER: 'xai' | 'anthropic' = process.env.XAI_API_KEY ? 'xai' : 'anthropic';

// Titles sent per trader to LLM (enough to infer but not overwhelming)
const MAX_TITLES_PER_TRADER = 15;

// Traders batched per LLM call to save tokens
const LLM_BATCH_SIZE = 8;

const KNOWN_CATEGORIES = [
  'NBA', 'NFL', 'NHL', 'Soccer', 'NCAA', 'MLB', 'Tennis', 'Golf', 'MMA',
  'Politics', 'Finance', 'Crypto', 'Entertainment',
  'Formula1', 'Boxing', 'Rugby', 'Cricket', 'eSports', 'Weather', 'Tech', 'Other',
];

function extractDbName(uri: string): string {
  try { return new URL(uri).pathname.replace('/', '') || 'polymarket-test'; }
  catch { return uri.match(/\/([^/?]+)(\?|$)/)?.[1] ?? 'polymarket-test'; }
}

// ── LLM call ──────────────────────────────────────────────────────────────────

interface TraderForLLM {
  wallet: string;
  titles: string[];
}

interface LLMResult {
  wallet: string;
  specialty: string;
}

async function classifyWithLLM(batch: TraderForLLM[]): Promise<LLMResult[]> {
  const prompt = `You are classifying Polymarket prediction market traders by their specialty.

Each trader has a list of market titles they traded. Based on the titles, pick the single best specialty from this list:
NBA, NFL, NHL, Soccer, NCAA, MLB, Tennis, Golf, MMA, Politics, Finance, Crypto, Entertainment, Formula1, Boxing, Rugby, Cricket, eSports, Weather, Tech, Other

Rules:
- Pick the single most dominant specialty even if the trader is mixed
- Use "Other" only if truly no pattern is visible
- Prefer specific over generic (e.g. "NFL" over "Sports")
- Return ONLY a JSON array, no explanation

Input traders:
${batch.map(t => `{"wallet":"${t.wallet}","titles":${JSON.stringify(t.titles.slice(0, MAX_TITLES_PER_TRADER))}}`).join('\n')}

Return format (one object per trader, same order):
[{"wallet":"0x...","specialty":"CategoryName"},...]`;

  if (LLM_PROVIDER === 'xai') {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) throw new Error('XAI_API_KEY not set');

    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'grok-3-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 512,
        temperature: 0,
      }),
    });
    if (!res.ok) throw new Error(`xAI API error ${res.status}: ${await res.text()}`);
    const data: any = await res.json();
    const text: string = data.choices?.[0]?.message?.content ?? '';
    return parseJsonArray(text, batch);

  } else {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
    const data: any = await res.json();
    const text: string = data.content?.[0]?.text ?? '';
    return parseJsonArray(text, batch);
  }
}

function parseJsonArray(text: string, batch: TraderForLLM[]): LLMResult[] {
  try {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON array found');
    const parsed: LLMResult[] = JSON.parse(match[0]);
    // Validate + filter to known wallets
    const walletSet = new Set(batch.map(t => t.wallet));
    return parsed.filter((r: any) =>
      typeof r.wallet === 'string' &&
      typeof r.specialty === 'string' &&
      walletSet.has(r.wallet)
    );
  } catch (e: any) {
    console.warn(`  [LLM] JSON parse failed: ${e.message}`);
    console.warn(`  Raw: ${text.slice(0, 300)}`);
    return [];
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) { console.error('MONGODB_URI not set'); process.exit(1); }

  if (!SKIP_LLM) {
    if (LLM_PROVIDER === 'xai' && !process.env.XAI_API_KEY)
      { console.error('XAI_API_KEY not set (or ANTHROPIC_API_KEY). Use --skip-llm to run step 1 only.'); process.exit(1); }
    if (LLM_PROVIDER === 'anthropic' && !process.env.ANTHROPIC_API_KEY)
      { console.error('ANTHROPIC_API_KEY not set (and no XAI_API_KEY). Use --skip-llm to run step 1 only.'); process.exit(1); }
  }

  const mongoClient = new MongoClient(mongoUri);
  await mongoClient.connect();
  const db = mongoClient.db(process.env.MONGODB_DB_NAME || extractDbName(mongoUri));

  const edgeCol    = db.collection('ahf-edgeRankedTraders');
  const profileCol = db.collection('polymarket-traderProfiles');

  // 1. Fetch all edge traders with specialty='Other'
  const others = await edgeCol.find({ specialty: 'Other' }).toArray();
  console.log(`Found ${others.length} edge traders with specialty='Other'\n`);

  if (others.length === 0) { await mongoClient.close(); return; }

  const resolved:  Array<{ wallet: string; specialty: string; source: string }> = [];
  const needsLLM:  Array<TraderForLLM> = [];
  const noData:    string[] = [];

  // 2. Step 1: infer from category_breakdown
  process.stdout.write('Step 1: inferring from category_breakdown...\n');

  // Batch-fetch all profiles in one round trip (was 428 sequential findOnes)
  const wallets = others.map(t => (t.wallet as string).toLowerCase());
  process.stdout.write(`  Fetching ${wallets.length} profiles in one query... `);
  const t0 = Date.now();
  const profiles = await profileCol.find(
    { wallet: { $in: wallets } },
    { projection: { wallet: 1, category_breakdown: 1, market_titles_summary: 1 } }
  ).toArray();
  console.log(`${profiles.length} found in ${((Date.now()-t0)/1000).toFixed(1)}s`);

  const profileByWallet = new Map<string, any>(
    profiles.map((p: any) => [(p.wallet as string).toLowerCase(), p])
  );

  for (const trader of others) {
    const wallet = (trader.wallet as string).toLowerCase();
    const profile: any = profileByWallet.get(wallet);

    if (!profile) {
      noData.push(wallet);
      continue;
    }

    // Find dominant non-'Other' category by total_pnl with enough trades
    const breakdown: any[] = profile.category_breakdown ?? [];
    const nonOther = breakdown
      .filter(c => c.category !== 'Other' && c.total_pnl > 0 && (c.closed_positions ?? 0) >= MIN_TRADES_FOR_BREAKDOWN_SPECIALTY)
      .sort((a, b) => b.total_pnl - a.total_pnl);

    if (nonOther.length > 0) {
      resolved.push({ wallet, specialty: nonOther[0].category, source: 'breakdown' });
      continue;
    }

    // Collect raw 'Other' market titles for LLM
    const titles: string[] = (profile.market_titles_summary ?? [])
      .filter((m: any) => m.category === 'Other')
      .map((m: any) => m.title as string);

    // Also include titles from non-'Other' categories that are in breakdown but below threshold
    // — the mix of titles gives LLM more context
    const allTitles: string[] = (profile.market_titles_summary ?? [])
      .map((m: any) => m.title as string);

    if (allTitles.length > 0) {
      needsLLM.push({ wallet, titles: allTitles });
    } else {
      noData.push(wallet);
    }
  }

  console.log(`  Resolved via breakdown:      ${resolved.length}`);
  console.log(`  Needs LLM classification:    ${needsLLM.length}`);
  console.log(`  No profile/titles data:      ${noData.length}\n`);

  // 3. Step 2: LLM classification
  if (!SKIP_LLM && needsLLM.length > 0) {
    const provider = LLM_PROVIDER === 'xai' ? 'Grok (grok-3-mini)' : 'Claude Haiku';
    console.log(`Step 2: classifying ${needsLLM.length} traders via ${provider}...`);
    const batchCount = Math.ceil(needsLLM.length / LLM_BATCH_SIZE);

    for (let i = 0; i < needsLLM.length; i += LLM_BATCH_SIZE) {
      const batch = needsLLM.slice(i, i + LLM_BATCH_SIZE);
      const batchNum = Math.floor(i / LLM_BATCH_SIZE) + 1;
      process.stdout.write(`  Batch ${batchNum}/${batchCount} (${batch.length} traders)...`);

      try {
        const results = await classifyWithLLM(batch);
        for (const r of results) {
          resolved.push({ wallet: r.wallet, specialty: r.specialty, source: 'llm' });
        }
        const missed = batch.length - results.length;
        console.log(` ${results.length} classified${missed > 0 ? `, ${missed} missed` : ''}`);
      } catch (e: any) {
        console.error(`\n  Batch ${batchNum} failed: ${e.message}`);
      }

      // Brief pause between batches to avoid rate limiting
      if (i + LLM_BATCH_SIZE < needsLLM.length) await new Promise(r => setTimeout(r, 500));
    }
    console.log();
  } else if (SKIP_LLM && needsLLM.length > 0) {
    console.log(`Step 2 skipped (--skip-llm). ${needsLLM.length} traders remain 'Other'.\n`);
  }

  // 4. Apply updates
  if (resolved.length === 0) {
    console.log('Nothing to update.');
    await mongoClient.close();
    return;
  }

  console.log(`Applying ${resolved.length} updates${DRY_RUN ? ' (DRY RUN — no writes)' : ''}:\n`);

  // Print preview table
  const bySource = { breakdown: 0, llm: 0 };
  const specialtyCounts: Record<string, number> = {};

  for (const u of resolved) {
    bySource[u.source as keyof typeof bySource] = (bySource[u.source as keyof typeof bySource] ?? 0) + 1;
    specialtyCounts[u.specialty] = (specialtyCounts[u.specialty] ?? 0) + 1;
    console.log(`  ${u.wallet.slice(0, 10)}... → ${u.specialty.padEnd(15)} [${u.source}]`);
  }

  console.log(`\nBreakdown by specialty:`);
  for (const [sp, cnt] of Object.entries(specialtyCounts).sort((a,b) => b[1]-a[1])) {
    console.log(`  ${sp.padEnd(18)} ${cnt}`);
  }
  console.log(`\nSources: ${bySource.breakdown} from breakdown, ${bySource.llm ?? 0} from LLM`);

  if (!DRY_RUN) {
    process.stdout.write('\nWriting updates via bulkWrite... ');
    const tw = Date.now();
    const ops = resolved.map(u => ({
      updateOne: {
        filter: { wallet: u.wallet },
        update: { $set: { specialty: u.specialty } },
      },
    }));
    const [edgeRes, profileRes] = await Promise.all([
      edgeCol.bulkWrite(ops, { ordered: false }),
      profileCol.bulkWrite(ops, { ordered: false }),
    ]);
    console.log(`done in ${((Date.now()-tw)/1000).toFixed(1)}s`);
    console.log(`  ahf-edgeRankedTraders:        ${edgeRes.modifiedCount} modified`);
    console.log(`  polymarket-traderProfiles:    ${profileRes.modifiedCount} modified`);
  }

  if (noData.length > 0) {
    console.log(`\n${noData.length} traders had no profile data — still 'Other':`);
    noData.forEach(w => console.log(`  ${w}`));
  }

  await mongoClient.close();
}

main().catch(e => { console.error(e); process.exit(1); });
