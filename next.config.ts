import type { NextConfig } from 'next'

// ─── Environment flag ─────────────────────────────────────────────────────────
// next.config.ts is evaluated by the Next.js CLI, so NODE_ENV is already set
// ('development' for `next dev`, 'production' for `next build`).

const isDev = process.env.NODE_ENV === 'development'

// RD-EVENT-17 — same explicit opt-in as lib/firebase/emulator.ts. Fail-safe off: anything
// other than the exact string 'true' leaves the production CSP untouched.
const useEmulator = process.env.NEXT_PUBLIC_FIREBASE_EMULATOR === 'true'

// ─── Content-Security-Policy ─────────────────────────────────────────────────
//
// Key decisions:
//
//   script-src 'unsafe-inline'
//     Next.js App Router injects inline hydration scripts.  A nonce-based
//     upgrade is tracked as a future hardening item.
//
//   script-src 'unsafe-eval' (development only)
//     Turbopack HMR and React DevTools both require eval().  Blocked in
//     production where neither tool runs.
//
//   connect-src ws://localhost:* (development only)
//     Next.js Fast Refresh communicates over a WebSocket to the dev server.
//     'self' does not cover ws:// scheme, so it must be listed explicitly.
//     Omitted from production builds.
//
//   img-src https:
//     Firebase Storage CDN, Unsplash, organiser-supplied image URLs.
//
//   connect-src *.googleapis.com / *.firebaseio.com / wss:
//     Firebase Auth token refresh, Firestore listeners, Storage uploads.
//
//   frame-src 'self' blob: checkout.razorpay.com api.razorpay.com
//                    www.youtube.com www.youtube-nocookie.com player.vimeo.com
//     Razorpay checkout renders inside an iframe from the razorpay origins.
//     'self' + blob: allow the certificate builder to frame server-generated
//     PDF previews delivered as same-origin blob: URLs. The YouTube/Vimeo
//     origins allow the organiser's promotional video to embed (normalised to
//     an /embed/ URL before rendering) on the event page and the wizard preview.
//
//   frame-ancestors 'none'
//     Clickjacking protection. X-Frame-Options: DENY covers older browsers.

function buildCSP(): string {
  const connectSrc = [
  "'self'",
  'https://*.googleapis.com',
  'https://*.firebaseio.com',
  'wss://*.firebaseio.com',

  // Cloudflare R2 uploads
  'https://*.r2.cloudflarestorage.com',

  'https://api.razorpay.com',
  'https://lumberjack.razorpay.com',

  ...(isDev ? ['ws://localhost:*', 'ws://127.0.0.1:*'] : []),

  // RD-EVENT-17 — Firebase Emulator Suite (auth 9099, firestore 8080, storage 9199).
  //
  // The emulators are served over PLAIN HTTP on a loopback port, which `'self'` and the
  // https://*.googleapis.com entries above do not cover, so every SDK call is refused by
  // connect-src. This is not a dev-only concern: profiling runs a PRODUCTION build against
  // the emulators, so it cannot be gated on `isDev`.
  //
  // Gated on the same explicit opt-in flag as the SDK wiring, so a real production build —
  // where the variable is unset or 'false' — emits a byte-identical CSP.
  ...(useEmulator ? ['http://127.0.0.1:9099', 'http://127.0.0.1:8080', 'http://127.0.0.1:9199', 'ws://127.0.0.1:*'] : []),
]

  const scriptSrc = [
    "'self'",
    "'unsafe-inline'",
    // Turbopack and React DevTools require eval() in development
    ...(isDev ? ["'unsafe-eval'"] : []),
    'checkout.razorpay.com',
  ]

  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src ${connectSrc.join(' ')}`,
    // maps.google.com — the venue map iframe on public event pages (VenueShowcase).
    // www.google.com is required as well: maps.google.com/maps?…&output=embed REDIRECTS
    // to www.google.com/maps/embed?…, and CSP is re-evaluated on the redirect target, so
    // allow-listing only the first host still fails on the hop.
    "frame-src 'self' blob: checkout.razorpay.com api.razorpay.com https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com https://maps.google.com https://www.google.com",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
}

// ─── Security headers ─────────────────────────────────────────────────────────

const securityHeaders = [
  // Force HTTPS for two years; include subdomains; eligible for preload list.
  {
    key:   'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  // Prevent MIME-type sniffing on served assets.
  {
    key:   'X-Content-Type-Options',
    value: 'nosniff',
  },
  // Block this site from being framed (legacy browser support).
  {
    key:   'X-Frame-Options',
    value: 'DENY',
  },
  // Limit referrer information sent to third-party origins.
  {
    key:   'Referrer-Policy',
    value: 'strict-origin-when-cross-origin',
  },
  // Disable browser features not used by this application.
  {
    key:   'Permissions-Policy',
    value: 'camera=(); microphone=(); geolocation=()',
  },
  {
    key:   'Content-Security-Policy',
    value: buildCSP(),
  },
]

// ─── Next.js config ───────────────────────────────────────────────────────────

/**
 * RD-MEDIA-01 — allows next/image to render photos served from object storage.
 *
 * The hostname comes from R2_PUBLIC_URL because it is deployment-specific. A malformed or
 * absent value yields an EMPTY list rather than a wildcard: failing closed keeps the
 * image allow-list meaningful, and an unconfigured deployment simply cannot serve photos —
 * which is the correct outcome, not a security hole.
 */
function r2RemotePattern(): NonNullable<NonNullable<NextConfig['images']>['remotePatterns']> {
  const raw = (process.env.R2_PUBLIC_URL ?? '').trim()
  if (!raw) return []
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:') return []
    return [{ protocol: 'https', hostname: url.hostname, port: '', pathname: '/**' }]
  } catch {
    return []
  }
}

const nextConfig: NextConfig = {
  // RD-EVENT-29 — build isolation for the emulator profile.
  //
  // THE TRAP THIS REMOVES: `next start` reads its build manifest once, at boot. Running a
  // plain `npm run build` afterwards replaces `.next` underneath the already-running
  // emulator server, which then serves chunk filenames that no longer exist — every JS
  // request 500s with `text/plain`, the page server-renders but never hydrates, and the
  // login button silently does nothing. It presents as an auth failure and is not one.
  //
  // This cost real debugging time in RD-EVENT-17, 25, 28 and 29. Options considered:
  //   B (stop `build` clobbering) — needs a guard on the standard build. Rejected: it
  //     touches the production path to fix a dev-only problem.
  //   C (always rebuild before verifying) — a convention, not a mechanism. It is exactly
  //     the convention that was already documented and still forgotten four times.
  //   A (separate output dir) — chosen. The two builds can no longer occupy the same
  //     directory, so the collision is impossible rather than merely discouraged.
  //
  // Production is untouched: with `NEXT_DIST_DIR` unset this is `.next`, byte-identical to
  // before. Only `.env.emulator` sets it.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  images: {
    // Trusted image providers only. Kept in sync with APPROVED_IMAGE_HOSTS in
    // lib/utils/imageUrl.ts. Google cached thumbnails (encrypted-tbn0.gstatic.com)
    // and googleusercontent mirrors are intentionally NOT allowed — organiser
    // cover URLs are validated against this list and fall back to a placeholder.
    remotePatterns: [
      { protocol: 'https', hostname: 'firebasestorage.googleapis.com', port: '', pathname: '/**' },
      { protocol: 'https', hostname: 'storage.googleapis.com',         port: '', pathname: '/**' },
      { protocol: 'https', hostname: 'res.cloudinary.com',             port: '', pathname: '/**' },
      { protocol: 'https', hostname: 'images.unsplash.com',            port: '', pathname: '/**' },
      // RD-MEDIA-01: the object-storage public domain, read from R2_PUBLIC_URL at build
      // time. Derived rather than hardcoded because the hostname is deployment-specific —
      // a self-hosted CDN, an r2.dev subdomain, or a custom domain. When the variable is
      // unset the entry is omitted entirely, so the allow-list never grows a bogus host.
      ...r2RemotePattern(),
    ],
  },

  async headers() {
    return [
      {
        source:  '/(.*)',
        headers: securityHeaders,
      },
      // Prevent browsers from serving stale cached HTML for dashboard routes.
      // Without this, pressing Back after logout could show a cached page shell
      // before onAuthStateChanged redirects to login.
      {
        source:  '/dashboard(.*)',
        headers: [
          { key: 'Cache-Control', value: 'no-store, must-revalidate' },
        ],
      },
    ]
  },
}

export default nextConfig
