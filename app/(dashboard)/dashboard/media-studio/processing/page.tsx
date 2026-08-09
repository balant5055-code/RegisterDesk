// RD-MEDIA-01 · Processing Jobs.
//
// HONEST SURFACE. Compression and rendition generation run in the BROWSER during an import
// (see the Sprint 6 report, conflict F2: this codebase has no server-side image library, and
// routing thousands of photos through the app server is neither possible on a serverless
// deployment nor desirable anywhere). There is therefore no server-side IMAGE job queue.
//
// RD-AI-01 added the one thing that does run on a server: the AI analysis pipeline. Its
// panel below reports its real state, which today is "not configured" — no provider is
// implemented, so nothing is queued and no photo is sent anywhere.
//
// Rather than invent an empty jobs table, this page explains where processing happens and
// points at the live queue, which is on the Import page.

import Link from 'next/link'
import { Cpu, Gauge, ImageDown, ShieldCheck } from 'lucide-react'
import { Banner, Card, buttonVariants } from '@/components/ui'
import { ROUTES } from '@/config/navigation'
import { AiPipelinePanel } from '@/features/ai/components/AiPipelinePanel'
import { MediaStudioHeader } from '@/features/media-studio/components/MediaStudioHeader'

export const metadata = { title: 'Processing Jobs — Media Studio' }

const STEPS = [
  { icon: ImageDown,   title: 'Compression',           text: 'Each photo is re-encoded to your chosen profile before anything leaves your machine.' },
  { icon: Gauge,       title: 'Medium + thumbnail',    text: 'A 1600px and a 400px version are generated for fast viewing.' },
  { icon: ShieldCheck, title: 'Checksum',              text: 'A sha256 of the original identifies duplicates and proves integrity.' },
  { icon: Cpu,         title: 'Metadata',              text: 'Dimensions, sizes and storage keys are recorded once the bytes are confirmed in storage.' },
] as const

export default function MediaStudioProcessingPage() {
  return (
    <div className="space-y-5">
      {/* RD-MEDIA-UX-04 — unified with every other Media Studio page. */}
      <MediaStudioHeader
        title="Processing Jobs"
        subtitle="What happens to each photo between selection and storage."
      />

      <Banner tone="info" title="Image processing runs in your browser">
        Photos are compressed and resized on your own machine, then uploaded straight to
        object storage. None of that queues on a server, so there is no background job list
        here — the live queue is on the Import page while an upload is running.
      </Banner>

      {/* RD-AI-01: analysis is the one thing that does run server-side, so the page says so
          rather than leaving the claim above sounding absolute. */}
      <AiPipelinePanel />

      <ul className="grid gap-3 sm:grid-cols-2">
        {STEPS.map(s => (
          <li key={s.title}>
            <Card className="h-full">
              <div className="flex items-start gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted" aria-hidden>
                  <s.icon className="size-[18px] text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-fs-md font-semibold text-foreground">{s.title}</h2>
                  <p className="mt-1 text-[13.5px] leading-relaxed text-muted-foreground">{s.text}</p>
                </div>
              </div>
            </Card>
          </li>
        ))}
      </ul>

      <Link href={ROUTES.MEDIA_STUDIO_IMPORT} className={buttonVariants({ variant: 'primary', size: 'sm' })}>
        Go to Import Media
      </Link>
    </div>
  )
}
