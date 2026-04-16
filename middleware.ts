import { NextRequest, NextResponse } from 'next/server';

const COOKIE = 'dashboard_auth';
const PUBLIC_SITE = 'https://yieldr.org';

const PROTECTED = ['/copy-trading', '/api/copy-trading'];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow the login page and its API route through
  if (pathname === '/login' || pathname.startsWith('/api/auth/')) {
    return NextResponse.next();
  }

  const isProtected = PROTECTED.some(p => pathname === p || pathname.startsWith(p + '/'));
  if (!isProtected) return NextResponse.next();

  const secret = process.env.DASHBOARD_SECRET;
  if (!secret) return NextResponse.next(); // misconfigured — fail open in dev

  const token = req.cookies.get(COOKIE)?.value;
  if (token === secret) return NextResponse.next();

  // Unauthenticated — redirect API calls to 401, page visits to public site
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.redirect(PUBLIC_SITE);
}

export const config = {
  matcher: ['/copy-trading/:path*', '/api/copy-trading/:path*', '/login'],
};
