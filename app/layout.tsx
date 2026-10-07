import type { Metadata, Viewport } from 'next'
import { Geist, Fraunces } from 'next/font/google'
import { BASE_URL } from '@/lib/env'
import { BUSINESS_CONFIG_DEFAULTS } from '@/lib/config/businessConfig'
import { AuthProvider } from '@/components/auth/AuthProvider'
import './globals.css'
import 'swiper/css'
import 'swiper/css/pagination'

// Geist is a variable font — all weights (100–900) ship in one file, so no `weight`
// array is passed (unlike Poppins). Exposed as --font-geist → --font-sans → font-sans.
const geist = Geist({
  subsets:  ['latin'],
  display:  'swap',
  variable: '--font-geist',
})

// RD-HERO-03 · the landing hero's display face. Fraunces is a variable serif with an
// optical-size axis, so the same file sets a 90px headline with fine hairlines and a 44px
// one with sturdier strokes. Loaded here (the root layout) because next/font must be
// declared in a module Next controls; exposed as --font-fraunces → --font-display →
// font-display. It is used by the hero headline and nowhere else — everything that is
// not a headline stays in Geist.
const fraunces = Fraunces({
  subsets:  ['latin'],
  display:  'swap',
  style:    ['normal', 'italic'],
  axes:     ['opsz'],
  variable: '--font-fraunces',
})

// LS1: metadataBase (so relative OG image URLs resolve) + default OpenGraph/Twitter
// so pages that don't set their own still share something meaningful. Kept `title`
// a plain default (no template) to avoid regressing pages that already self-brand.
//
// RD-CONF-10: the platform NAME is sourced from the branding code default (one
// source of truth) rather than a bare literal. This layout wraps every route, so
// it stays STATIC — it must not read Firestore. Runtime-editable branding applies
// to dynamic/client surfaces (sitemap, robots, event/campaign metadata, provider);
// static metadata reflects the code default and changes on redeploy.
const NAME  = BUSINESS_CONFIG_DEFAULTS.branding.platformName
const TITLE = `${NAME} — Event Registration, Check-in & Payments`
const DESC  = 'Create events, sell tickets, check in attendees, and manage payments — all in one platform.'

export const metadata: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: TITLE,
  description: DESC,
  applicationName: NAME,

  icons: {
    // /favicon.ico is emitted automatically from app/favicon.ico (the file convention), so
    // it is not listed here — listing it again only duplicated the <link>.
    icon: [
      {
        url: '/favicon/favicon-96x96.png',
        sizes: '96x96',
        type: 'image/png',
      },
    ],
    apple: '/favicon/apple-touch-icon.png',
  },

  manifest: '/favicon/site.webmanifest',

  openGraph: {
  type: 'website',
  siteName: NAME,
  url: BASE_URL,
  title: TITLE,
  description: DESC,
  images: [
    {
      url: '/og-image.png',
      width: 1200,
      height: 630,
      alt: `${NAME} - Event Registration Platform`,
    },
  ],
},

  twitter: {
  card: 'summary_large_image',
  title: NAME,
  description: DESC,
  images: ['/og-image.png'],
},
}

// GA-7D S2: `viewport-fit=cover` so iOS populates env(safe-area-inset-*), which the
// wizard footer and other bottom-anchored controls already reference (they resolved
// to 0 without this). Next injects width/initial-scale automatically; this adds the fit.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  // The browser/OS chrome colour: Android's toolbar, the iOS PWA status bar, the tab
  // strip on desktop Chrome. It is the LAST retired-magenta reference in the application
  // shell — everything public now runs on the action ramp.
  //
  // It is a literal, and it has to be: this becomes <meta name="theme-color" content="…">,
  // which the browser reads before any stylesheet exists, so a var(--action) here would
  // resolve to nothing. #4F46E5 IS --action (styles/tokens.css) — if that token ever moves,
  // this moves with it. Solid by contract: theme-color takes one colour, never a gradient.
  themeColor: '#4F46E5',
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geist.variable} ${fraunces.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  )
}
