// Full-screen certificate builder (Phase 10C). Desktop-first; view-only on mobile.
// Auth + data loading happen client-side in BuilderClient (it acquires the
// Firebase ID token and calls the Phase 10B template / layout / preview APIs).

import BuilderClient from '@/components/certificates/builder/BuilderClient'

export const metadata = { title: 'Certificate Builder – RegisterDesk' }

type PageProps = { params: Promise<{ eventId: string; templateId: string }> }

export default async function CertificateBuilderPage({ params }: PageProps) {
  const { eventId, templateId } = await params
  return <BuilderClient eventId={eventId} templateId={templateId} />
}
