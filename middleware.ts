// Next.js middleware — runs on the Edge runtime before route handlers.
//
// What this middleware does:
//   1. Normalises /admin and /admin/ → /admin/dashboard (eliminates the 404).
//
// What this middleware intentionally does NOT do:
//   Firebase ID-token verification requires the Firebase Admin SDK which uses
//   Node.js-only APIs and cannot run on the Edge runtime.  Full admin-identity
//   verification therefore happens in app/(admin)/layout.tsx:
//     • onAuthStateChanged resolves the Firebase user client-side.
//     • The layout calls GET /api/admin/auth-check (Node.js route handler) with
//       a Bearer token before rendering any admin content.
//     • Non-admin authenticated users see an "Access Denied" screen.
//     • Unauthenticated users are redirected to /login.
//
// If you later add HTTP-only session cookies (e.g. via a POST /api/session
// endpoint after admin login), you can verify them here with a lightweight
// fetch to /api/admin/auth-check and gain a true server-side gate.

import { type NextRequest, NextResponse } from 'next/server'

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl

  // Redirect bare /admin → /admin/dashboard so the route group root
  // returns a page instead of a 404.
  if (pathname === '/admin' || pathname === '/admin/') {
    return NextResponse.redirect(new URL('/admin/dashboard', request.url))
  }

  return NextResponse.next()
}

export const config = {
  // Only run on the bare /admin path — all other /admin/* routes are handled
  // by their page files and the layout auth check.
  matcher: ['/admin', '/admin/'],
}
