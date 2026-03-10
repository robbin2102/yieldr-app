import { NextRequest, NextResponse } from 'next/server';
import { fetchNews, formatArticlesForLLM } from '@/lib/rss';

/**
 * GET /api/news/rss
 *
 * Query params:
 *   topics     – comma-separated keywords, e.g. "iran,oil,sanctions"
 *   sourceTypes – "geo" | "crypto" | "all"  (default: all)
 *   limit      – articles per feed (default: 3, max: 5)
 *   maxAge     – max article age in minutes (default: 1440 = 24h)
 *   format     – "llm" (compact JSON for tool responses) | "full" (default)
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);

    const topics = searchParams.get('topics') ?? undefined;
    const rawSourceTypes = searchParams.get('sourceTypes') ?? 'all';
    const sourceTypes =
      rawSourceTypes === 'geo' || rawSourceTypes === 'crypto' ? rawSourceTypes : 'all';
    const limitPerFeed = Math.min(parseInt(searchParams.get('limit') ?? '3', 10), 5);
    const maxAgeMinutes = parseInt(searchParams.get('maxAge') ?? '1440', 10);
    const format = searchParams.get('format') === 'llm' ? 'llm' : 'full';

    const articles = await fetchNews({ topics, sourceTypes, limitPerFeed, maxAgeMinutes });

    if (format === 'llm') {
      return new NextResponse(formatArticlesForLLM(articles), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return NextResponse.json({
      fetchedAt: new Date().toISOString(),
      count: articles.length,
      articles,
    });
  } catch (err: any) {
    console.error('[news/rss] error:', err.message);
    return NextResponse.json({ error: 'Failed to fetch news' }, { status: 500 });
  }
}
