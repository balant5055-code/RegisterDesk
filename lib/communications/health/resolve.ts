// RD-COMMS-01 Phase 2 — SERVER resolver: the ONE canonical communication read model.
//
// resolveCommunicationContext() is the single seam every surface reads for communication
// state (Business Config, Communication Center, Event Builder, Dashboard, Publish). It
// gathers REAL runtime signals — provider configuration (isChannelConfigured), the layered
// communication config, the wallet balance, and template presence — and feeds the PURE
// builders (./build). READ-ONLY: it sends nothing, charges nothing, mutates nothing, and
// changes no provider/wallet/billing behavior.
//
// Server-only (reads env-backed provider config + the wallet). No UI computes this itself.

import { isChannelConfigured } from '@/lib/notifications/providerResolver'
import { NotificationChannel } from '@/lib/notifications/channels'
import { getCommunicationConfig, type CommunicationResolutionContext } from '@/lib/communications/resolveCommunicationConfig'
import { getWalletBalance } from '@/lib/firebase/firestore/wallet'
import { WHATSAPP_TEMPLATE_REGISTRY } from '@/lib/whatsapp'
import type { CommunicationConfig } from '@/lib/config/businessConfig'
import { buildChannelHealth, buildCommunicationReadiness } from './build'
import { rollupStatus, type ChannelSignals } from './channels'
import type {
  CommunicationHealth,
  CommunicationReadiness,
  CommunicationScope,
  WalletSnapshot,
} from './types'

/** The resolved communication context — the composite read model surfaces consume. */
export interface ResolvedCommunicationContext {
  scope:      CommunicationScope
  config:     CommunicationConfig
  wallet:     WalletSnapshot
  health:     CommunicationHealth
  readiness:  CommunicationReadiness
}

/** Optional event-scope inputs the caller already holds (event pricing flags). Passing
 *  them keeps this resolver decoupled from event-doc fetching. */
export interface CommunicationResolveOptions {
  event?: {
    whatsappEnabled?: boolean
    smsEnabled?:      boolean
  }
}

const WHATSAPP_TEMPLATES_PRESENT = Object.keys(WHATSAPP_TEMPLATE_REGISTRY).length > 0

/** Build the four channel signal sets from measured runtime values. */
function gatherSignals(
  config:  CommunicationConfig,
  wallet:  WalletSnapshot,
  scope:   CommunicationScope,
  opts?:   CommunicationResolveOptions,
): Record<'email' | 'whatsapp' | 'sms' | 'push', ChannelSignals> {
  const eventScoped = Boolean(scope.eventId)
  const fundedFor = (pricePaise: number): boolean | null =>
    wallet.known ? wallet.balancePaise >= Math.max(0, pricePaise) : null

  return {
    email: {
      configured:         isChannelConfigured(NotificationChannel.EMAIL),
      platformEnabled:    config.email.enabled,
      healthy:            true,
      funded:             null,               // email is free
      templatesAvailable: true,               // global fallback always resolves
      event:              eventScoped ? { enabled: true } : undefined,
    },
    whatsapp: {
      configured:         isChannelConfigured(NotificationChannel.WHATSAPP),
      platformEnabled:    config.whatsapp.enabled,
      healthy:            true,
      funded:             fundedFor(config.whatsapp.pricePaise),
      templatesAvailable: WHATSAPP_TEMPLATES_PRESENT,
      event:              eventScoped ? { enabled: Boolean(opts?.event?.whatsappEnabled) } : undefined,
    },
    sms: {
      configured:         false,              // no SMS transport exists
      platformEnabled:    config.sms.enabled,
      healthy:            true,
      funded:             fundedFor(config.sms.pricePaise),
      templatesAvailable: false,
      event:              eventScoped ? { enabled: Boolean(opts?.event?.smsEnabled) } : undefined,
    },
    push: {
      configured:         false,              // no push transport exists
      platformEnabled:    false,
      healthy:            true,
      funded:             null,
      templatesAvailable: false,
      event:              eventScoped ? { enabled: false } : undefined,
    },
  }
}

/**
 * THE canonical resolver. Resolves communication config (platform → organizer → event as
 * those layers come online), the wallet snapshot, and the derived health + readiness for a
 * scope. Read-only.
 */
export async function resolveCommunicationContext(
  scope:  CommunicationScope = {},
  opts?:  CommunicationResolveOptions,
): Promise<ResolvedCommunicationContext> {
  const ctx: CommunicationResolutionContext = {
    organizerUid: scope.organizerUid,
    eventId:      scope.eventId,
  }
  const config = await getCommunicationConfig(ctx)

  const wallet: WalletSnapshot = scope.organizerUid
    ? { balancePaise: await getWalletBalance(scope.organizerUid), known: true }
    : { balancePaise: 0, known: false }

  const signals = gatherSignals(config, wallet, scope, opts)

  const channels = [
    buildChannelHealth('email',    signals.email),
    buildChannelHealth('whatsapp', signals.whatsapp),
    buildChannelHealth('sms',      signals.sms),
    buildChannelHealth('push',     signals.push),
  ]
  const health: CommunicationHealth = {
    scope,
    channels,
    overall: rollupStatus(channels.map(c => c.status)),
  }

  const readiness = buildCommunicationReadiness({
    email:              signals.email,
    whatsapp:           signals.whatsapp,
    sms:                signals.sms,
    certificateEnabled: config.certificates.enabled,
  })

  return { scope, config, wallet, health, readiness }
}

/** Convenience: health only. */
export async function resolveCommunicationHealth(
  scope?: CommunicationScope,
  opts?:  CommunicationResolveOptions,
): Promise<CommunicationHealth> {
  return (await resolveCommunicationContext(scope, opts)).health
}

/** Convenience: readiness only. */
export async function resolveCommunicationReadiness(
  scope?: CommunicationScope,
  opts?:  CommunicationResolveOptions,
): Promise<CommunicationReadiness> {
  return (await resolveCommunicationContext(scope, opts)).readiness
}
