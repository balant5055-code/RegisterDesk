// /admin/preview/events/[slug] — Super Admin pre-approval preview of the PUBLIC event page.
// Metadata (noindex, no canonical) comes from app/(admin-preview)/layout.tsx; the client
// component fetches the Super-Admin-only preview API and renders the real TemplateRouter.

import { AdminEventPreview } from './AdminEventPreview'

export default async function AdminEventPreviewPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  return <AdminEventPreview slug={slug} />
}
