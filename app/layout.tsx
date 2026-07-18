import type { Metadata, Viewport } from 'next'
import { Geist } from 'next/font/google'
import { BASE_URL } from '@/lib/env'
import { BUSINESS_CONFIG_DEFAULTS } from '@/lib/config/businessConfig'
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
    icon: [
      { url: '/favicon.ico' },
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
  themeColor: '#e5277e',
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geist.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  )
}
