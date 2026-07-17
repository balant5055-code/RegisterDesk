import type { NextConfig } from 'next'

// ─── Environment flag ─────────────────────────────────────────────────────────
// next.config.ts is evaluated by the Next.js CLI, so NODE_ENV is already set
// ('development' for `next dev`, 'production' for `next build`).

const isDev = process.env.NODE_ENV === 'development'

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
    'https://api.razorpay.com',
    'https://lumberjack.razorpay.com',
    // Fast Refresh / Turbopack WebSocket (dev only)
    ...(isDev ? ['ws://localhost:*', 'ws://127.0.0.1:*'] : []),
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
    "frame-src 'self' blob: checkout.razorpay.com api.razorpay.com https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com",
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

const nextConfig: NextConfig = {
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
