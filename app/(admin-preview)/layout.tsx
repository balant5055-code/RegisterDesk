// Route group for the Super Admin pre-approval event preview (/admin/preview/events/[slug]).
//
// Deliberately OUTSIDE both route groups it sits beside:
//   • app/events/[slug] — its layout 404s anything not publicly viewable, so a pending event
//     can never be rendered there (by design; that gate is unchanged).
//   • app/(admin) — its console shell (sidebar, top bar) would wrap the page and the preview
//     would no longer look like the public page it stands in for.
// The same pattern as app/(admin-auth), which serves /admin/login without the console shell.
//
// Authorization is NOT this layout's job: the data comes only from
// GET /api/admin/events/[slug]/preview, which enforces Super Admin server-side.
//
// Never indexable, never canonical: noindex/nofollow here, no `alternates` anywhere in this
// group, `/admin` is disallowed in robots.ts, and the sitemap never lists it.

import type { Metadata } from 'next'

export const metadata: Metadata = {
  title:  'Event preview — RegisterDesk Admin',
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
}

export default function AdminPreviewLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
