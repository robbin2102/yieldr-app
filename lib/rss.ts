/**
 * RSS feed fetcher + lightweight XML parser.
 * No external XML dependency — uses simple regex extraction.
 * Feeds confirmed working as of 2026-03-08.
 */

export interface RssArticle {
  title: string;
  url: string;
  source: string;
  sourceType: 'geo' | 'crypto';
  publishedAt: string;     // ISO-8601
  ageMinutes: number;
  snippet: string;         // first ~150 chars of description, plain text
}

interface RssSource {
  name: string;
  url: string;
  type: 'geo' | 'crypto';
}

export const RSS_SOURCES: RssSource[] = [
  { name: 'BBC World',     url: 'https://feeds.bbci.co.uk/news/world/rss.xml',        type: 'geo' },
  { name: 'Al Jazeera',   url: 'https://www.aljazeera.com/xml/rss/all.xml',           type: 'geo' },
  { name: 'Sky News',     url: 'https://feeds.skynews.com/feeds/rss/world.xml',       type: 'geo' },
  { name: 'NPR World',    url: 'https://feeds.npr.org/1004/rss.xml',                  type: 'geo' },
  { name: 'CoinTelegraph',url: 'https://cointelegraph.com/rss',                       type: 'crypto' },
];

// ─── In-memory cache (5-minute TTL per feed) ─────────────────────────────────
interface FeedCache {
  articles: RssArticle[];
  fetchedAt: number;
}
const feedCache = new Map<string, FeedCache>();
const FEED_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ─── XML helpers ─────────────────────────────────────────────────────────────

/** Extract all <item>...</item> blocks from RSS XML */
function extractItems(xml: string): string[] {
  const items: string[] = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) items.push(m[1]);
  return items;
}

/** Get text content of a tag, handling CDATA and HTML entities */
function getTagText(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*?))<\\/${tag}>`, 'i');
  const m = xml.match(re);
  if (!m) return '';
  const raw = (m[1] ?? m[2] ?? '').trim();
  return raw
    .replace(/<[^>]+>/g, ' ')         // strip HTML tags
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&apos;|&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Get the <link> value (may be plain text or inside <![CDATA[ ]]>) */
function getLink(itemXml: string): string {
  // Try <link>url</link> first (plain)
  const plain = itemXml.match(/<link>\s*(https?:\/\/[^\s<]+)\s*<\/link>/i);
  if (plain) return plain[1].trim();
  // CDATA variant
  const cdata = itemXml.match(/<link[^>]*>\s*<!\[CDATA\[(.*?)\]\]>\s*<\/link>/i);
  if (cdata) return cdata[1].trim();
  // Atom-style: <link href="url" .../>
  const href = itemXml.match(/<link[^>]+href=["']([^"']+)["']/i);
  if (href) return href[1].trim();
  return '';
}

function parsePubDate(raw: string): { iso: string; ageMinutes: number } {
  try {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) {
      return {
        iso: d.toISOString(),
        ageMinutes: Math.round((Date.now() - d.getTime()) / 60000),
      };
    }
  } catch {/* ignore */}
  return { iso: new Date().toISOString(), ageMinutes: 0 };
}

// ─── Single-feed fetch ────────────────────────────────────────────────────────

async function fetchFeed(source: RssSource, limitPerFeed: number): Promise<RssArticle[]> {
  const cached = feedCache.get(source.url);
  if (cached && Date.now() - cached.fetchedAt < FEED_CACHE_TTL_MS) {
    return cached.articles.slice(0, limitPerFeed);
  }

  try {
    const res = await fetch(source.url, {
      headers: { 'User-Agent': 'yieldr-rss-bot/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const items = extractItems(xml).slice(0, 20); // parse up to 20, cache all

    const articles: RssArticle[] = items.map(item => {
      const title = getTagText(item, 'title');
      const url = getLink(item);
      const description = getTagText(item, 'description');
      const snippet = description.slice(0, 160).replace(/\s+/g, ' ').trim();
      const pubRaw = getTagText(item, 'pubDate') || getTagText(item, 'dc:date') || getTagText(item, 'published');
      const { iso, ageMinutes } = parsePubDate(pubRaw);

      return { title, url, source: source.name, sourceType: source.type, publishedAt: iso, ageMinutes, snippet };
    }).filter(a => a.title && a.url);

    feedCache.set(source.url, { articles, fetchedAt: Date.now() });
    return articles.slice(0, limitPerFeed);
  } catch (err: any) {
    console.warn(`[rss] Failed to fetch ${source.name}: ${err.message}`);
    return [];
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export interface FetchNewsOptions {
  /** Comma-separated keywords to filter by (case-insensitive, title+snippet) */
  topics?: string;
  /** 'geo' | 'crypto' | 'all' — which source types to include */
  sourceTypes?: 'geo' | 'crypto' | 'all';
  /** Max articles per feed (default: 3) */
  limitPerFeed?: number;
  /** Only return articles newer than this many minutes (default: 1440 = 24h) */
  maxAgeMinutes?: number;
}

export async function fetchNews(opts: FetchNewsOptions = {}): Promise<RssArticle[]> {
  const {
    topics,
    sourceTypes = 'all',
    limitPerFeed = 3,
    maxAgeMinutes = 1440,
  } = opts;

  const keywords = topics
    ? topics.toLowerCase().split(/[,\s]+/).filter(Boolean)
    : [];

  const sources = RSS_SOURCES.filter(s =>
    sourceTypes === 'all' || s.type === sourceTypes
  );

  // Fetch all feeds in parallel
  const results = await Promise.all(sources.map(s => fetchFeed(s, limitPerFeed)));

  let articles = results.flat();

  // Age filter
  articles = articles.filter(a => a.ageMinutes <= maxAgeMinutes);

  // Keyword filter (if provided, title OR snippet must contain at least one keyword)
  if (keywords.length > 0) {
    articles = articles.filter(a => {
      const haystack = `${a.title} ${a.snippet}`.toLowerCase();
      return keywords.some(kw => haystack.includes(kw));
    });
  }

  // Sort by recency
  articles.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

  return articles;
}

/** Format articles as compact JSON for Claude tool responses (token-efficient) */
export function formatArticlesForLLM(articles: RssArticle[]): string {
  if (articles.length === 0) return JSON.stringify({ articles: [], count: 0 });

  return JSON.stringify({
    fetchedAt: new Date().toISOString(),
    count: articles.length,
    articles: articles.map(a => ({
      title: a.title,
      url: a.url,
      source: a.source,
      type: a.sourceType,
      age: a.ageMinutes < 60
        ? `${a.ageMinutes}m ago`
        : `${Math.round(a.ageMinutes / 60)}h ago`,
      publishedAt: a.publishedAt,
      snippet: a.snippet,
    })),
  }, null, 0); // no pretty-print = fewer tokens
}
