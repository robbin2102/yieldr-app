/**
 * get_news_headlines Tool
 * Fetch live RSS headlines from 5 confirmed-working feeds.
 * No external XML parser — uses simple regex extraction.
 * 5-minute in-process cache per feed.
 */

import { z } from 'zod';

export const getNewsHeadlinesSchema = z.object({
  topics: z
    .string()
    .optional()
    .describe('Comma-separated keywords to filter headlines, e.g. "iran,oil,sanctions". Omit for top headlines.'),
  sourceTypes: z
    .enum(['geo', 'crypto', 'all'])
    .optional()
    .default('all')
    .describe('"geo" for world news (BBC, AJZ, Sky, NPR), "crypto" for crypto news (CoinTelegraph), "all" for both.'),
  limitPerFeed: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .default(3)
    .describe('Max articles per RSS source (default: 3, max: 5).'),
  maxAgeMinutes: z
    .number()
    .int()
    .min(1)
    .optional()
    .default(1440)
    .describe('Only return articles published in the last N minutes (default: 1440 = 24h).'),
});

export type GetNewsHeadlinesInput = z.infer<typeof getNewsHeadlinesSchema>;

// ─── RSS Sources ─────────────────────────────────────────────────────────────

const RSS_SOURCES = [
  { name: 'BBC World',     url: 'https://feeds.bbci.co.uk/news/world/rss.xml',    type: 'geo' },
  { name: 'Al Jazeera',   url: 'https://www.aljazeera.com/xml/rss/all.xml',       type: 'geo' },
  { name: 'Sky News',     url: 'https://feeds.skynews.com/feeds/rss/world.xml',   type: 'geo' },
  { name: 'NPR World',    url: 'https://feeds.npr.org/1004/rss.xml',              type: 'geo' },
  { name: 'CoinTelegraph',url: 'https://cointelegraph.com/rss',                   type: 'crypto' },
] as const;

// ─── Cache ────────────────────────────────────────────────────────────────────
const feedCache = new Map<string, { articles: any[]; fetchedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

// ─── Minimal XML helpers ──────────────────────────────────────────────────────
function extractItems(xml: string): string[] {
  const items: string[] = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) items.push(m[1]);
  return items;
}

function getTagText(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*?))<\\/${tag}>`, 'i');
  const m = xml.match(re);
  if (!m) return '';
  return ((m[1] ?? m[2] ?? '').trim())
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&apos;|&#039;/g, "'").replace(/&quot;/g, '"').replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function getLink(itemXml: string): string {
  const plain = itemXml.match(/<link>\s*(https?:\/\/[^\s<]+)\s*<\/link>/i);
  if (plain) return plain[1].trim();
  const cdata = itemXml.match(/<link[^>]*>\s*<!\[CDATA\[(.*?)\]\]>\s*<\/link>/i);
  if (cdata) return cdata[1].trim();
  const href = itemXml.match(/<link[^>]+href=["']([^"']+)["']/i);
  if (href) return href[1].trim();
  return '';
}

// ─── Fetch one feed ───────────────────────────────────────────────────────────
async function fetchFeed(source: typeof RSS_SOURCES[number], limit: number) {
  const cached = feedCache.get(source.url);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.articles.slice(0, limit);
  }
  try {
    const res = await fetch(source.url, {
      headers: { 'User-Agent': 'yieldr-rss-bot/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const articles = extractItems(xml).slice(0, 20).map(item => {
      const pubRaw = getTagText(item, 'pubDate') || getTagText(item, 'dc:date');
      let publishedAt = new Date().toISOString();
      let ageMinutes = 0;
      try {
        const d = new Date(pubRaw);
        if (!isNaN(d.getTime())) {
          publishedAt = d.toISOString();
          ageMinutes = Math.round((Date.now() - d.getTime()) / 60000);
        }
      } catch { /**/ }
      const desc = getTagText(item, 'description');
      return {
        title: getTagText(item, 'title'),
        url: getLink(item),
        source: source.name,
        type: source.type,
        publishedAt,
        age: ageMinutes < 60 ? `${ageMinutes}m ago` : `${Math.round(ageMinutes / 60)}h ago`,
        ageMinutes,
        snippet: desc.slice(0, 160).trim(),
      };
    }).filter(a => a.title && a.url);
    feedCache.set(source.url, { articles, fetchedAt: Date.now() });
    return articles.slice(0, limit);
  } catch (err: any) {
    return [];
  }
}

// ─── Execute ──────────────────────────────────────────────────────────────────
export async function executeGetNewsHeadlines(input: GetNewsHeadlinesInput) {
  const { topics, sourceTypes = 'all', limitPerFeed = 3, maxAgeMinutes = 1440 } = input;
  const keywords = topics ? topics.toLowerCase().split(/[,\s]+/).filter(Boolean) : [];
  const sources = RSS_SOURCES.filter(s => sourceTypes === 'all' || s.type === sourceTypes);

  const results = await Promise.all(sources.map(s => fetchFeed(s, limitPerFeed)));
  let articles = results.flat().filter(a => a.ageMinutes <= maxAgeMinutes);

  if (keywords.length > 0) {
    articles = articles.filter(a => {
      const hay = `${a.title} ${a.snippet}`.toLowerCase();
      return keywords.some(kw => hay.includes(kw));
    });
  }

  articles.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

  return {
    fetchedAt: new Date().toISOString(),
    count: articles.length,
    articles: articles.map(({ ageMinutes: _age, ...rest }) => rest), // drop raw ageMinutes
  };
}

// ─── Tool export (matches MCP server registry pattern) ────────────────────────
export const getNewsHeadlinesTool = {
  name: 'get_news_headlines' as const,
  description:
    'Fetch the latest news headlines from 5 live RSS feeds (BBC World, Al Jazeera, Sky News, NPR World, CoinTelegraph). Returns top articles with title, clickable URL, source, age, and snippet. Supports keyword filtering via topics= and source type filtering (geo/crypto/all).',
  inputSchema: getNewsHeadlinesSchema,
  execute: executeGetNewsHeadlines,
};
