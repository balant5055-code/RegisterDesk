'use client'

// Phase B — the Payment Gateway section of Business Configuration.
//
// Specialized rather than a flat SectionEditor for two reasons a field list cannot express:
// the choice depends on server-computed READINESS (a gateway can be unselectable), and
// changing where attendee money goes deserves an explicit confirmation that states what the
// change does and does not affect.
//
// It reuses the page's existing draft → publish → reason workflow, the engine's own
// validator, and the shared Button/Badge primitives. No new design system, no new settings
// mechanism, no new persistence path.

import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils/cn'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Undo2, ShieldCheck, Lock, AlertTriangle, Split } from 'lucide-react'
import { CONFIG_SECTION_REGISTRY, BUSINESS_CONFIG_DEFAULTS } from '@/lib/config/businessConfig'
import type { GatewayReadiness } from '@/app/api/admin/business-config/route'

type SectionDraft = Record<string, unknown>

type ProviderId = 'razorpay' | 'cashfree'

const PROVIDERS: { id: ProviderId; name: string; blurb: string }[] = [
  { id: 'razorpay', name: 'Razorpay', blurb: 'The gateway currently in production. Always available.' },
  { id: 'cashfree', name: 'Cashfree', blurb: 'Prepared gateway. Sandbox only while production activation is pending.' },
]

export function PaymentGatewayEditor({
  published, draft, onDraftChange, onPublish, publishing, gateways, canEditPricing,
}: {
  published:     SectionDraft
  draft:         SectionDraft
  onDraftChange: (d: SectionDraft) => void
  onPublish:     () => void
  publishing:    boolean
  /** Server-computed. Booleans and an environment name only — never a credential. */
  gateways:      GatewayReadiness
  /** RD-PHASE4-S2 — server-decided from the verified token. The payment provider is Super Admin only. */
  canEditPricing: boolean
}) {
  const validation = useMemo(() => CONFIG_SECTION_REGISTRY.payments.validate(draft), [draft])
  const dirty      = useMemo(() => JSON.stringify(draft) !== JSON.stringify(published), [draft, published])
  const [confirming, setConfirming] = useState(false)

  const selected  = (draft.activeProvider as ProviderId) ?? 'razorpay'
  const live      = (published.activeProvider as ProviderId) ?? 'razorpay'

  const selectable = (id: ProviderId) =>
    canEditPricing && (id === 'razorpay' ? gateways.razorpaySelectable : gateways.cashfreeSelectable)

  /** Why Cashfree cannot be chosen — stated plainly, without naming configuration internals. */
  const cashfreeBlockedReason = (): string => {
    if (gateways.cashfreeSelectable) return ''
    return gateways.cashfreeEnvironment === 'production'
      ? 'Cashfree production is not activated for this environment yet. It cannot be selected until activation and its production credentials are confirmed.'
      : 'Cashfree is not enabled in this environment. Its sandbox credentials and feature flag must be configured before it can be selected.'
  }

  return (
    <section className="space-y-5">
      <header className="space-y-1">
        <h2 className="text-fs-lg font-semibold tracking-tight text-foreground">Payment Gateway</h2>
        <p className="text-fs-xs text-muted-foreground">
          Selects the gateway used to create <strong className="font-semibold text-foreground">new</strong> payment
          orders. Payments that already exist keep the gateway they were created with.
        </p>
      </header>

      {!canEditPricing && (
        <p role="status" className="rounded-xl border border-border bg-muted/40 px-3.5 py-2 text-[11.5px] text-muted-foreground">
          View only. Changing the payment gateway requires a Super Admin.
        </p>
      )}

      {/* Currently live — the published value, not the draft, so the admin can always see
          what attendees are actually being charged through right now. */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-3.5 py-2.5">
        <span className="text-fs-2xs font-semibold uppercase tracking-wide text-muted-foreground">Currently live</span>
        <Badge variant="secondary" className="font-semibold">
          {PROVIDERS.find(p => p.id === live)?.name ?? live}
        </Badge>
        {live === 'cashfree' && (
          <Badge variant="outline" className="font-medium capitalize">{gateways.cashfreeEnvironment}</Badge>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {PROVIDERS.map(p => {
          const isSelected = selected === p.id
          const enabled    = selectable(p.id)
          return (
            <button
              key={p.id}
              type="button"
              disabled={!enabled}
              aria-pressed={isSelected}
              onClick={() => { if (enabled) onDraftChange({ ...draft, activeProvider: p.id }) }}
              className={cn(
                'rounded-xl border p-3.5 text-left transition-colors',
                isSelected ? 'border-primary bg-primary/[0.04]' : 'border-border bg-card hover:border-border-strong',
                !enabled && 'cursor-not-allowed opacity-60 hover:border-border',
              )}
            >
              <span className="flex items-center gap-2">
                <span className="text-fs-sm font-semibold text-foreground">{p.name}</span>
                {isSelected && <ShieldCheck className="size-3.5 text-primary" aria-hidden />}
                {!enabled  && <Lock className="size-3.5 text-muted-foreground" aria-hidden />}
              </span>
              <span className="mt-1 block text-fs-2xs leading-relaxed text-muted-foreground">{p.blurb}</span>

              {p.id === 'cashfree' && (
                <span className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline" className="capitalize">{gateways.cashfreeEnvironment}</Badge>
                  <Badge variant={gateways.cashfreeSandboxReady ? 'secondary' : 'outline'}>
                    sandbox {gateways.cashfreeSandboxReady ? 'ready' : 'not ready'}
                  </Badge>
                  <Badge variant={gateways.cashfreeProductionReady ? 'secondary' : 'outline'}>
                    production {gateways.cashfreeProductionReady ? 'ready' : 'not activated'}
                  </Badge>
                </span>
              )}
            </button>
          )
        })}
      </div>

      {!gateways.cashfreeSelectable && (
        <p className="flex items-start gap-2 rounded-xl border border-border bg-muted/40 px-3.5 py-2.5 text-fs-2xs leading-relaxed text-muted-foreground">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>{cashfreeBlockedReason()}</span>
        </p>
      )}

      {!validation.valid && (
        <p className="text-fs-2xs font-medium text-destructive">{validation.errors.join(' · ')}</p>
      )}

      {/* ═══ EASY SPLIT · INFORMATIONAL ONLY ═══════════════════════════════════
          Rendered as static copy with NO control of any kind — no toggle, no
          select, no disabled input that a future edit might quietly enable. A
          disabled control invites someone to remove the `disabled`; text does not.
          Nothing in the payments config section corresponds to it, so there is
          nothing for a request to set even if one were crafted by hand. */}
      <div className="rounded-xl border border-dashed border-border bg-muted/30 p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <Split className="size-4 text-muted-foreground" aria-hidden />
          <h3 className="text-fs-sm font-semibold text-foreground">Easy Split</h3>
          <Badge variant="outline" className="font-medium">Coming soon</Badge>
        </div>
        <p className="mt-1.5 text-fs-2xs leading-relaxed text-muted-foreground">
          Automatically split registration payments between RegisterDesk and eligible event
          organizers through Cashfree.
        </p>
        <p className="mt-2 text-fs-2xs leading-relaxed text-muted-foreground">
          Not available yet. It requires Cashfree account activation and organizer
          eligibility, and neither is confirmed. Organizer payouts continue to run through
          the existing settlement process in the meantime.
        </p>
      </div>

      {/* Confirmation. Deliberately states the blast radius — an admin changing this is
          changing where money goes, and the one thing they must not assume is that it
          retroactively moves payments already in flight. */}
      {confirming && dirty && (
        <div className="space-y-2.5 rounded-xl border border-border-strong bg-card p-3.5">
          <p className="text-fs-sm font-semibold text-foreground">
            Switch new payment orders to {PROVIDERS.find(p => p.id === selected)?.name}?
          </p>
          <ul className="space-y-1 text-fs-2xs leading-relaxed text-muted-foreground">
            <li>· Applies only to payment orders created from now on.</li>
            <li>· Payments already created stay on their original gateway for verification, refunds and settlement.</li>
            <li>· You will be asked for a reason, which is recorded in the configuration audit trail.</li>
          </ul>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => { setConfirming(false); onPublish() }} disabled={publishing}>
              {publishing ? 'Publishing…' : 'Confirm and continue'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setConfirming(false)} disabled={publishing}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={() => setConfirming(true)}
          disabled={!canEditPricing || !dirty || !validation.valid || publishing || confirming}
        >
          Publish change
        </Button>
        <Button
          size="sm" variant="ghost"
          onClick={() => { setConfirming(false); onDraftChange(JSON.parse(JSON.stringify(published)) as SectionDraft) }}
          disabled={!dirty || publishing}
        >
          <Undo2 className="size-3.5" aria-hidden /> Discard
        </Button>
        <Button
          size="sm" variant="ghost"
          onClick={() => { setConfirming(false); onDraftChange({ ...BUSINESS_CONFIG_DEFAULTS.payments }) }}
          disabled={!canEditPricing || publishing}
        >
          Reset to default
        </Button>
      </div>
    </section>
  )
}
