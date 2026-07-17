// Channel-agnostic broadcast-job dispatch (OE-2). Maps a campaign to its runner
// job (WhatsApp WA-3 or Email OE-2) so ONE set of progress/process/cancel routes +
// ONE progress UI serve both channels — no per-channel duplication.

import type { ProcessResult } from '@/lib/jobs/runner'
import { WHATSAPP_BROADCAST_JOBS, processWhatsAppBroadcastChunk } from './whatsappJob'
import { EMAIL_BROADCAST_JOBS, processEmailBroadcastChunk } from './emailJob'

export type BroadcastJobChannel = 'email' | 'whatsapp'

export interface CampaignJobPointer {
  collection: string
  jobId:      string | null
  channel:    BroadcastJobChannel | null
}

/** Resolves a campaign doc to the collection + id of the runner job executing it. */
export function campaignJobPointer(
  c: { channel?: string; whatsappJobId?: string; emailJobId?: string } | undefined,
): CampaignJobPointer {
  if (c?.channel === 'email') {
    return { collection: EMAIL_BROADCAST_JOBS, jobId: typeof c.emailJobId === 'string' ? c.emailJobId : null, channel: 'email' }
  }
  if (c?.channel === 'whatsapp') {
    return { collection: WHATSAPP_BROADCAST_JOBS, jobId: typeof c.whatsappJobId === 'string' ? c.whatsappJobId : null, channel: 'whatsapp' }
  }
  return { collection: '', jobId: null, channel: null }
}

/** Advances one chunk of the campaign's job (dispatched by channel). */
export function processCampaignJobChunk(channel: BroadcastJobChannel, jobId: string): Promise<ProcessResult> {
  return channel === 'email' ? processEmailBroadcastChunk(jobId) : processWhatsAppBroadcastChunk(jobId)
}
