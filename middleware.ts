import { NextRequest, NextResponse } from 'next/server';

const COOKIE      = 'dashboard_auth';
const PUBLIC_SITE = 'https://yieldr.org';

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Always allow login page and auth API
  if (pathname === '/login' || pathname.startsWith('/api/auth/')) {
    return NextResponse.next();
  }

  const secret = process.env.DASHBOARD_SECRET;
  if (!secret) return NextResponse.next(); // fail-open if env var not set

  const token = req.cookies.get(COOKIE)?.value;
  if (token === secret) return NextResponse.next();

  // Not authenticated — API gets 401, page visits redirect to public site
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.redirect(new URL(PUBLIC_SITE));
}

export const config = {
  // Match /copy-trading, /copy-trading/*, /api/copy-trading, /api/copy-trading/*, and /login
  matcher: [
    '/copy-trading',
    '/copy-trading/:path+',
    '/api/copy-trading/:path+',
    '/login',
  ],
};
