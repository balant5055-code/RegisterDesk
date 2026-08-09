'use client'

// RD-PRODUCT-01G Phase 8 — Step 4 (Passes & Pricing) of the Event Builder wizard.
//
// Extracted VERBATIM from the Event Builder monolith
// (app/(dashboard)/dashboard/events/new/page.tsx). Step4View is PRESENTATIONAL: it owns only
// Step-4-local UI state (the pricing draft — event type, passes, registration schedule,
// advanced-settings toggle, pass-editor overlay) and pushes its result UP to the parent via
// the StepViewProps callbacks (onNext / onBack / onSaveDraft / onAutosave). It holds NO wizard
// navigation, Firestore, validation engine, licensing, coupon, communications, or publishing
// logic — the parent page remains the single source of truth.
//
// Everything in this file belongs ONLY to Step 4: the pass-id helper (generatePassId) and the
// Step-4 presentational sub-components (RegTypeCard, EventTypeSelectorSection, PassesSection,
// RegistrationPeriodSection, AdvancedSettingsSection, Step4SummaryPanel). The shared bits —
// the AddPassEditor overlay, the fee-preview helpers (calcFees/feeRatesFrom/FEE_MODEL_LABELS),
// and the fee/services sections consumed by Step 7 — are NOT here: the AddPassEditor is
// imported, and the Step-7-consumed fee code stays in the parent. The shared autosave-emit
// hook (useAutosaveEmit) is imported from lib/events/builder — not duplicated.

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowLeft,
  ArrowRight,
  Calendar,
  Check,
  ChevronDown,
  Copy,
  Eye,
  Hash,
  Headphones,
  Heart,
  IndianRupee,
  Info,
  Lock,
  Pencil,
  Plus,
  Settings2,
  Tag,
  Ticket,
  Trash2,
  TrendingUp,
  Users,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { buttonVariants } from '@/components/ui'
import { WizardFooter } from '@/components/wizard/WizardFooter'
import { Stepper } from '@/components/event-builder/Stepper'
import { AddPassEditor } from '@/components/wizard/AddPassEditor'
import { EASE, WIZARD_STEPS, PASS_COLORS } from '@/lib/events/builder/constants'
import type { StepViewProps, EventPass, EventPricingDraft, EventPricingType } from '@/lib/events/builder/types'
import { SUPPORTED_FEE_MODEL, normalizeFeeModel } from '@/lib/events/builder/types'
import { useFeesConfig } from '@/lib/fees/feesConfigClient'
import { formatINR } from '@/lib/events/builder/format'
import { validateStep } from '@/lib/events/builder/stepValidation'
import { useAutosaveEmit } from '@/lib/events/builder/useAutosaveEmit'
import { ROUTES } from '@/config/navigation'
import { cn } from '@/lib/utils/cn'

function generatePassId(): string {
  return 'pass_' + Math.random().toString(36).slice(2, 10)
}

// INR_FORMAT + formatINR extracted to lib/events/builder/format.ts (RD-PRODUCT-01G).

// --- Fee model types + calculator ---------------------------------------------

// FeeModel / FeeBreakdown / FeeRates types → lib/events/builder/types.ts (RD-PRODUCT-01G Phase 4).

function RegTypeCard({
  selected, onClick, icon: Icon, title, subtitle, description, examples, dividerClass,
}: {
  selected:     boolean
  onClick:      () => void
  icon:         LucideIcon
  title:        string
  subtitle:     string
  description:  string
  examples:     string[]
  dividerClass: string
}) {
  const [infoOpen, setInfoOpen]   = useState(false)
  const [coords, setCoords]       = useState({ top: 0, left: 0 })
  const iconBtnRef                = useRef<HTMLButtonElement>(null)
  const popoverDivRef             = useRef<HTMLDivElement>(null)

  const openInfo = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!infoOpen && iconBtnRef.current) {
      const r   = iconBtnRef.current.getBoundingClientRect()
      const top = r.bottom + window.scrollY + 6
      // clamp left so popover (208px wide) never overflows the right viewport edge
      const left = Math.min(r.left + window.scrollX, window.innerWidth - 216)
      setCoords({ top, left })
    }
    setInfoOpen(v => !v)
  }

  useEffect(() => {
    if (!infoOpen) return
    const close = (e: MouseEvent) => {
      if (
        iconBtnRef.current?.contains(e.target as Node) ||
        popoverDivRef.current?.contains(e.target as Node)
      ) return
      setInfoOpen(false)
    }
    const dismiss = () => setInfoOpen(false)
    document.addEventListener('mousedown', close)
    window.addEventListener('scroll', dismiss, { passive: true })
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', dismiss)
      window.removeEventListener('resize', dismiss)
    }
  }, [infoOpen])

  return (
    <>
      {/* Fixed popover — position:fixed bypasses any ancestor overflow:hidden */}
      <AnimatePresence>
        {infoOpen && (
          <motion.div
            ref={popoverDivRef}
            initial={{ opacity: 0, y: 4, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 2, scale: 0.97 }}
            transition={{ duration: 0.14 }}
            style={{ position: 'fixed', top: coords.top, left: coords.left, zIndex: 9999 }}
            className="w-52 rounded-xl border border-border bg-card p-4 shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Best suited for</p>
            <ul className="flex flex-col gap-2">
              {examples.map(ex => (
                <li key={ex} className="flex items-center gap-2 text-[13px] text-foreground">
                  <span className="size-1.5 shrink-0 rounded-full bg-primary/50" aria-hidden />
                  {ex}
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div
        whileHover={{ y: selected ? 0 : -2 }}
        whileTap={{ scale: 0.998 }}
        onClick={onClick}
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onClick() }}
        className={cn(
          'relative cursor-pointer flex-col p-6 text-left transition-all duration-200 sm:p-7',
          dividerClass,
          selected
            ? 'bg-primary/[0.04] shadow-md ring-2 ring-inset ring-primary/20'
            : 'bg-card hover:shadow-lg',
        )}
      >
        {selected && (
          <span className="absolute inset-x-0 top-0 h-[3px]" style={{ backgroundImage: 'var(--primary-gradient)' }} aria-hidden />
        )}

        {/* Title row */}
        <div className="mb-3 flex items-center gap-3">
          <div className={cn(
            'flex size-11 shrink-0 items-center justify-center rounded-xl transition-colors',
            selected ? 'bg-primary/10' : 'bg-muted/50',
          )}>
            <Icon className={cn('size-5', selected ? 'text-primary' : 'text-muted-foreground/60')} aria-hidden />
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-1.5">
              <p className="text-[16px] font-bold text-foreground">{title}</p>
              <button
                ref={iconBtnRef}
                type="button"
                onClick={openInfo}
                aria-label={`Examples for ${title}`}
                className="flex items-center justify-center p-0.5 text-muted-foreground transition-colors hover:text-primary"
              >
                <Info className="size-4" aria-hidden />
              </button>
            </div>
            <p className={cn('text-[12px] font-semibold', selected ? 'text-primary' : 'text-muted-foreground/60')}>{subtitle}</p>
          </div>

        <div className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-all',
          selected ? 'border-primary bg-primary' : 'border-border bg-background',
        )}>
          {selected && <Check className="size-3 text-primary-foreground" aria-hidden />}
        </div>
      </div>

        {/* Description */}
        <p className="text-[13px] leading-relaxed text-muted-foreground">{description}</p>
      </motion.div>
    </>
  )
}

// Section 1: Registration Type — simple free / paid selector
function EventTypeSelectorSection({
  value,
  onChange,
}: {
  value:    EventPricingType
  onChange: (v: EventPricingType) => void
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-5 py-4 sm:px-6">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/[0.09]">
          <Ticket className="size-4 text-primary" aria-hidden />
        </div>
        <div>
          <p className="text-[15px] font-bold tracking-tight text-foreground">Registration Type</p>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Choose whether attendees will register for free or pay during registration.
          </p>
        </div>
      </div>

      {/* Two selection cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2">
        <RegTypeCard
          selected={value === 'free'}
          onClick={() => onChange('free')}
          icon={Heart}
          title="Free Registration"
          subtitle="No payment required"
          description="Attendees can register without making any payment."
          examples={['Community Programs', 'Awareness Campaigns', 'NGO Events', 'School Functions', 'Free Workshops']}
          dividerClass="border-b border-border/60 sm:border-b-0 sm:border-r"
        />
        <RegTypeCard
          selected={value === 'paid'}
          onClick={() => onChange('paid')}
          icon={IndianRupee}
          title="Paid Registration"
          subtitle="Online payment at checkout"
          description="Attendees must complete payment during registration."
          examples={['Marathons', 'Conferences', 'Training Programs', 'Exhibitions', 'Fundraising Events']}
          dividerClass=""
        />
      </div>
    </div>
  )
}

function PassesSection({
  passes,
  isFreeEvent,
  onUpdate,
  onAddNew,
  onEdit,
}: {
  passes:      EventPass[]
  isFreeEvent: boolean
  onUpdate:    (passes: EventPass[]) => void
  onAddNew:    () => void
  onEdit:      (pass: EventPass) => void
}) {
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)

  const toggleStatus = (id: string) =>
    onUpdate(passes.map(p =>
      p.id === id ? { ...p, status: p.status === 'active' ? 'inactive' : 'active' } : p
    ))

  const handleDuplicate = (pass: EventPass) => {
    const copy: EventPass = {
      ...pass,
      id:               generatePassId(),
      name:             `${pass.name} (Copy)`,
      status:           'inactive',
      benefits:         [...pass.benefits],
      customBenefits:   [...pass.customBenefits],
      raceDetails:      pass.raceDetails ? { ...pass.raceDetails } : null,
      advancedSettings: { ...pass.advancedSettings },
    }
    onUpdate([...passes, copy])
  }

  const handleDeleteConfirm = (id: string) => {
    onUpdate(passes.filter(p => p.id !== id))
    setDeleteConfirmId(null)
  }

  return (
    <div>
      {/* Table or empty state */}
      {passes.length === 0 ? (
        <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-border bg-muted/[0.03] py-14 text-center">
          <div className="flex size-14 items-center justify-center rounded-full bg-muted/40">
            <Ticket className="size-6 text-muted-foreground/40" aria-hidden />
          </div>
          <div>
            <p className="text-[13.5px] font-semibold text-foreground">No passes created yet</p>
            <p className="mt-1 max-w-[260px] text-[12px] leading-relaxed text-muted-foreground/70">
              Create your first pass to start accepting registrations.
            </p>
          </div>
          <button
            type="button"
            onClick={onAddNew}
            className="flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-[13px] font-semibold text-primary-foreground transition-colors hover:bg-[var(--primary-hover)]"
          >
            <Plus className="size-4" aria-hidden />
            Add First Pass
          </button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-left" aria-label="Ticket passes">
              <thead>
                <tr className="border-b border-border/70 bg-muted/[0.04]">
                  <th className="px-4 py-2.5 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Pass Name
                  </th>
                  <th className="px-3 py-2.5 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Price {!isFreeEvent && '(₹)'}
                  </th>
                  <th className="px-3 py-2.5 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Qty / Seats
                  </th>
                  <th className="px-3 py-2.5 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Early Bird (₹)
                  </th>
                  <th className="px-3 py-2.5 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Sales End
                  </th>
                  <th className="px-3 py-2.5 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Status
                  </th>
                  <th className="w-[88px] px-3 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {passes.map((pass, i) => {
                  const clr        = PASS_COLORS[i % PASS_COLORS.length]
                  const isDeleting = deleteConfirmId === pass.id
                  return (
                    <tr
                      key={pass.id}
                      className={cn(
                        'group border-b border-border/40 transition-colors last:border-0',
                        isDeleting ? 'bg-red-50/60' : 'hover:bg-muted/[0.04]',
                      )}
                    >
                      {/* Pass name + description */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', clr.bg)}>
                            <Ticket className={cn('size-3.5', clr.color)} aria-hidden />
                          </div>
                          <div className="min-w-0">
                            <p className="text-[14px] font-semibold leading-tight text-foreground">
                              {pass.name}
                            </p>
                            <p className="mt-0.5 max-w-[180px] truncate text-[12px] leading-snug text-muted-foreground">
                              {pass.description}
                            </p>
                          </div>
                        </div>
                      </td>
                      {/* Price */}
                      <td className="px-3 py-3">
                        {isFreeEvent ? (
                          <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-[2px] text-[12px] font-semibold text-emerald-600">
                            Free
                          </span>
                        ) : (
                          <span className="text-[13px] font-bold text-foreground">{formatINR(pass.price)}</span>
                        )}
                      </td>
                      {/* Quantity */}
                      <td className="px-3 py-3 text-[14px] text-foreground">
                        {pass.quantity !== null
                          ? pass.quantity.toLocaleString('en-IN')
                          : <span className="text-muted-foreground">Unlimited</span>
                        }
                      </td>
                      {/* Early bird price */}
                      <td className="px-3 py-3">
                        {pass.earlyBirdEnabled && pass.earlyBirdPrice !== null ? (
                          <span className="text-[14px] font-medium text-primary">
                            {formatINR(pass.earlyBirdPrice)}
                          </span>
                        ) : (
                          <span className="text-[12px] text-muted-foreground/40">—</span>
                        )}
                      </td>
                      {/* Sales end date */}
                      <td className="px-3 py-3 text-[12px] text-muted-foreground">
                        {pass.salesEndDate
                          ? new Date(pass.salesEndDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
                          : <span className="text-muted-foreground/40">—</span>
                        }
                      </td>
                      {/* Status toggle */}
                      <td className="px-3 py-3">
                        <button
                          type="button"
                          onClick={() => toggleStatus(pass.id)}
                          aria-label={`${pass.status === 'active' ? 'Deactivate' : 'Activate'} ${pass.name}`}
                          className={cn(
                            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold transition-colors',
                            pass.status === 'active'
                              ? 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100'
                              : 'bg-muted text-muted-foreground hover:bg-muted/70',
                          )}
                        >
                          <span className={cn(
                            'size-1.5 rounded-full',
                            pass.status === 'active' ? 'bg-emerald-500' : 'bg-muted-foreground/40',
                          )} />
                          {pass.status === 'active' ? 'Active' : 'Inactive'}
                        </button>
                      </td>
                      {/* Row actions */}
                      <td className="px-3 py-3">
                        {isDeleting ? (
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => handleDeleteConfirm(pass.id)}
                              className="rounded bg-red-500 px-2 py-0.5 text-[12px] font-semibold text-white hover:bg-red-600"
                            >
                              Confirm
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeleteConfirmId(null)}
                              className="rounded px-2 py-0.5 text-[12px] text-muted-foreground hover:bg-muted/40"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-0.5 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
                            <button
                              type="button"
                              onClick={() => onEdit(pass)}
                              className="flex size-6 items-center justify-center rounded-md text-muted-foreground/50 hover:bg-primary/10 hover:text-primary"
                              aria-label={`Edit ${pass.name}`}
                            >
                              <Pencil className="size-3.5" aria-hidden />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDuplicate(pass)}
                              className="flex size-6 items-center justify-center rounded-md text-muted-foreground/50 hover:bg-muted/60 hover:text-foreground"
                              aria-label={`Duplicate ${pass.name}`}
                            >
                              <Copy className="size-3.5" aria-hidden />
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeleteConfirmId(pass.id)}
                              className="flex size-6 items-center justify-center rounded-md text-muted-foreground/50 hover:bg-red-50 hover:text-red-500"
                              aria-label={`Delete ${pass.name}`}
                            >
                              <Trash2 className="size-3.5" aria-hidden />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Secondary add link — only shown when table already has entries */}
      {passes.length > 0 && (
        <button
          type="button"
          onClick={onAddNew}
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border py-2 text-[12px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
        >
          <Plus className="size-3.5" aria-hidden />
          Add another pass
        </button>
      )}
    </div>
  )
}

// Section 4: Registration Schedule — timeline-style card
function RegistrationPeriodSection({
  draft,
  onUpdate,
}: {
  draft:    EventPricingDraft
  onUpdate: (partial: Partial<EventPricingDraft>) => void
}) {
  const inputCls =
    'h-9 w-full rounded-lg border border-border bg-background px-3 text-[14px] text-foreground placeholder:text-muted-foreground/60 outline-none transition-colors focus:border-primary/50 focus:ring-2 focus:ring-primary/20'

  const milestones = [
    {
      key:     'open' as const,
      icon:    Zap,
      label:   'Registration Opens',
      hint:    'When attendees can start registering',
      optional: false,
      value:   draft.registrationOpenDate,
      onChange:(v: string) => onUpdate({ registrationOpenDate: v }),
      dotCls:  'bg-primary',
      iconCls: 'bg-primary/10 text-primary',
    },
    // Early Bird Ends is intentionally NOT here — it is a pass-level field set in
    // the pass editor (Pricing section), not an event-wide schedule milestone.
    {
      key:     'close' as const,
      icon:    Lock,
      label:   'Registration Closes',
      hint:    'Last day attendees can register',
      optional: false,
      value:   draft.registrationEndDate,
      onChange:(v: string) => onUpdate({ registrationEndDate: v }),
      dotCls:  'bg-rose-400',
      iconCls: 'bg-rose-50 text-rose-500',
    },
  ] as const

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      {/* Header */}
      <div className="border-b border-border px-5 py-4 sm:px-6">
        <p className="text-[15px] font-bold tracking-tight text-foreground">Registration Schedule</p>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          Control when your event is open for registration.
        </p>
      </div>

      {/* Timeline */}
      <div className="px-5 py-5 sm:px-6">
        <div className="flex flex-col gap-0">
          {milestones.map(({ key, icon: Icon, label, hint, optional, value, onChange, iconCls }, i, arr) => (
            <div key={key} className="flex items-start gap-4">
              {/* Dot + connector */}
              <div className="flex flex-col items-center">
                <div className={cn('flex size-9 shrink-0 items-center justify-center rounded-xl', iconCls)}>
                  <Icon className="size-4" aria-hidden />
                </div>
                {i < arr.length - 1 && (
                  <div className="my-1.5 w-px flex-1 bg-border/60" style={{ minHeight: '28px' }} />
                )}
              </div>

              {/* Content */}
              <div className={cn('min-w-0 flex-1', i < arr.length - 1 ? 'pb-5' : '')}>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <label className="text-[13px] font-semibold text-foreground">{label}</label>
                  {optional && (
                    <span className="rounded-full bg-muted/60 px-2 py-0.5 text-[12px] font-medium text-muted-foreground">
                      Optional
                    </span>
                  )}
                  {value && (
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[12px] font-semibold text-primary">
                      {new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </span>
                  )}
                </div>
                <input
                  type="date"
                  value={value}
                  onChange={e => onChange(e.target.value)}
                  className={cn(inputCls, 'max-w-[220px]')}
                  aria-label={label}
                />
                <p className="mt-1.5 text-[13px] text-muted-foreground">{hint}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Show remaining seats toggle */}
        <div className="mt-5 flex items-center justify-between gap-4 rounded-xl border border-border/60 bg-muted/[0.04] px-4 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted/50">
              <Users className="size-4 text-muted-foreground" aria-hidden />
            </div>
            <div className="min-w-0">
              <p className="text-[14px] font-semibold text-foreground">Show remaining seats</p>
              <p className="text-[13px] text-muted-foreground">Encourages early registration by showing available capacity</p>
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={draft.showRemainingSeats}
            onClick={() => onUpdate({ showRemainingSeats: !draft.showRemainingSeats })}
            className={cn(
              'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
              draft.showRemainingSeats ? 'bg-primary' : 'bg-muted-foreground/25',
            )}
          >
            <span className={cn(
              'inline-block size-[20px] rounded-full bg-white shadow-sm transition-transform duration-200',
              draft.showRemainingSeats ? 'translate-x-5' : 'translate-x-0',
            )} />
          </button>
        </div>
      </div>
    </div>
  )
}

function AdvancedSettingsSection({
  isOpen,
  onToggle,
}: {
  isOpen:   boolean
  onToggle: () => void
}) {
  const ITEMS = [
    {
      icon:  Hash,
      label: 'Taxes',
      desc:  'Configure GST and applicable tax rates',
      badge: '0 configured',
    },
    {
      icon:  IndianRupee,
      label: 'Convenience Fees',
      desc:  'Platform and payment gateway fees',
      badge: '0 configured',
    },
    {
      icon:  Tag,
      label: 'Coupons & Promo Codes',
      desc:  'Discount codes for attendees',
      badge: '0 active',
    },
    {
      icon:  TrendingUp,
      label: 'Group Discounts',
      desc:  'Volume discounts for group registrations',
      badge: '0 configured',
    },
  ]

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between rounded-xl border border-border bg-card px-4 py-3.5 shadow-sm transition-colors hover:bg-muted/[0.03]"
        aria-expanded={isOpen}
      >
        <div className="flex items-center gap-2.5">
          <Settings2 className="size-4 text-muted-foreground" aria-hidden />
          <p className="text-[13px] font-semibold text-foreground">Advanced Settings</p>
          <span className="rounded-full bg-muted/60 px-2 py-[2px] text-[12px] font-medium text-muted-foreground">
            Optional
          </span>
        </div>
        <ChevronDown
          className={cn('size-4 text-muted-foreground transition-transform duration-200', isOpen && 'rotate-180')}
          aria-hidden
        />
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="grid grid-cols-1 gap-3 pt-3 sm:grid-cols-2">
              {ITEMS.map(item => {
                const Icon = item.icon
                return (
                  <button
                    key={item.label}
                    type="button"
                    className="flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3.5 text-left shadow-sm transition-colors hover:border-border/80 hover:bg-muted/[0.04]"
                  >
                    <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/40">
                      <Icon className="size-3.5 text-muted-foreground" aria-hidden />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[14px] font-semibold text-foreground">{item.label}</p>
                      <p className="mt-0.5 text-[13px] text-muted-foreground">{item.desc}</p>
                    </div>
                    <span className="mt-0.5 shrink-0 rounded-full bg-muted/50 px-2 py-0.5 text-[12px] font-medium text-muted-foreground">
                      {item.badge}
                    </span>
                  </button>
                )
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
function Step4SummaryPanel({ pricing }: { pricing: EventPricingDraft }) {
  const activePasses     = pricing.passes.filter(p => p.status === 'active')
  const paidActivePasses = activePasses.filter(p => pricing.eventType === 'paid' && p.price > 0)
  const freePasses       = activePasses.filter(p => pricing.eventType === 'free' || p.price === 0)
  const hasUnlimited     = pricing.passes.some(p => p.unlimited)
  const totalSeats       = hasUnlimited
    ? null
    : pricing.passes.reduce((s, p) => s + (p.quantity ?? 0), 0)

  return (
    <aside className="flex flex-col gap-3 lg:sticky lg:top-5">

      {/* Pricing Summary */}
      <div className="rounded-xl border border-border bg-card shadow-sm">
        <div className="border-b border-border px-4 py-3">
          <p className="text-[14px] font-semibold text-foreground">Pricing Summary</p>
        </div>
        <div className="flex flex-col gap-0 divide-y divide-border/40 px-4 py-1">
          {([
            { label: 'Total Passes',  val: String(pricing.passes.length) },
            { label: 'Active Passes', val: String(activePasses.length)   },
            { label: 'Paid Passes',   val: String(paidActivePasses.length), hidden: pricing.eventType !== 'paid' },
            { label: 'Free Passes',   val: String(freePasses.length),       hidden: paidActivePasses.length === 0 && pricing.eventType === 'paid' },
            {
              label: 'Total Capacity',
              val:   hasUnlimited
                ? 'Unlimited'
                : totalSeats != null && totalSeats > 0
                ? totalSeats.toLocaleString('en-IN')
                : '—',
              valCls: hasUnlimited ? 'text-amber-600' : '',
            },
          ] as Array<{ label: string; val: string; valCls?: string; hidden?: boolean }>)
            .filter(r => !r.hidden)
            .map(({ label, val, valCls }) => (
              <div key={label} className="flex items-center justify-between py-2.5">
                <span className="text-[12px] text-muted-foreground">{label}</span>
                <span className={cn('text-[12px] font-semibold', valCls ?? 'text-foreground')}>{val}</span>
              </div>
            ))}
        </div>
      </div>

      {/* Event Preview */}
      <div className="rounded-xl border border-border bg-card shadow-sm">
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-center gap-1.5">
            <Eye className="size-3.5 text-muted-foreground" aria-hidden />
            <p className="text-[14px] font-semibold text-foreground">Event Preview</p>
          </div>
          <p className="mt-0.5 text-[12px] text-muted-foreground">How passes appear to attendees</p>
        </div>
        <div className="px-4 py-3">
          <div className="overflow-hidden rounded-lg border border-border/60">
            {/* Mini event header */}
            <div className="bg-gradient-to-br from-primary/[0.08] to-primary/[0.04] px-3 py-3">
              <p className="text-[12px] font-semibold text-foreground">Your Event Name</p>
              <div className="mt-1 flex items-center gap-1.5 text-[12px] text-muted-foreground">
                <Calendar className="size-3" aria-hidden />
                <span>Date TBD · Venue TBD</span>
              </div>
            </div>

            {/* Pass list preview */}
            {pricing.passes.length > 0 ? (
              <div className="divide-y divide-border/40">
                {pricing.passes.slice(0, 3).map((pass, i) => (
                  <div key={pass.id} className="flex items-center justify-between px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className={cn('size-2 rounded-full', PASS_COLORS[i % PASS_COLORS.length].dot)} />
                      <span className="max-w-[110px] truncate text-[13px] font-medium text-foreground">
                        {pass.name}
                      </span>
                    </div>
                    <span className="text-[13px] font-bold text-primary">
                      {pricing.eventType === 'free' ? 'Free' : formatINR(pass.price)}
                    </span>
                  </div>
                ))}
                {pricing.passes.length > 3 && (
                  <p className="px-3 py-1.5 text-center text-[12px] text-muted-foreground">
                    +{pricing.passes.length - 3} more pass{pricing.passes.length - 3 !== 1 ? 'es' : ''}
                  </p>
                )}
              </div>
            ) : (
              <div className="px-3 py-5 text-center">
                <p className="text-[13px] text-muted-foreground/60">No passes added yet</p>
              </div>
            )}

            {/* Register CTA preview */}
            <div className="border-t border-border/40 px-3 py-2.5">
              <div className="rounded-lg bg-primary/10 py-2 text-center">
                <p className="flex items-center gap-1 text-[13px] font-bold text-primary">
                  Register Now <ArrowRight className="size-3" aria-hidden />
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Need help */}
      <div className="rounded-xl border border-border bg-card px-4 py-3 shadow-sm">
        <div className="mb-1 flex items-center gap-1.5">
          <Headphones className="size-3.5 shrink-0 text-foreground" aria-hidden />
          <p className="text-[12px] font-semibold text-foreground">Need help with pricing?</p>
        </div>
        <p className="mb-2.5 text-[12px] leading-relaxed text-muted-foreground">
          Learn about ticket types, early bird pricing, and revenue best practices.
        </p>
        {/* GA-7 S1: pricing guide not yet published — action hidden until the guide exists. */}
      </div>

    </aside>
  )
}
export function Step4View({ currentStep, completedValues, onNext, onBack, onSaveDraft, onAutosave, initialData, wizardSteps }: StepViewProps) {
  const eventTypeId  = (initialData?.eventTypeId  as string | null) ?? null
  const eventSubtype = (initialData?.eventSubtype as string | null) ?? null
  // RD-PAYMENT-02 Phase 7: gate the stored fee-model normalization by the pricing engine so
  // a flag-on Attendee-Pays selection survives Back-navigation. Dormant → organizer_absorbs.
  const feeEngineEnabled = useFeesConfig().pricingEngineEnabled

  const [pricing, setPricing] = useState<EventPricingDraft>(() => {
    const savedRaw = initialData?.pricing as (EventPricingDraft & { earlyBirdEndDate?: unknown }) | null
    if (savedRaw) {
      // LS3.2 migration: the early-bird end date used to live at the event level
      // (pricing.earlyBirdEndDate). It now belongs only to the pass
      // (pricing.passes[].earlyBirdEndDate). Backfill any legacy value into
      // early-bird-enabled passes that don't yet have their own date, then drop
      // the legacy field so there is exactly one source of truth. No data loss.
      const { earlyBirdEndDate: legacyEbEnd, ...saved } = savedRaw
      const legacy = typeof legacyEbEnd === 'string' ? legacyEbEnd.trim() : ''
      const passes = Array.isArray(saved.passes)
        ? saved.passes.map(p =>
            legacy && p.earlyBirdEnabled && !p.earlyBirdEndDate
              ? { ...p, earlyBirdEndDate: legacy }
              : p,
          )
        : saved.passes
      return {
        ...saved,
        passes,
        feeModel:               normalizeFeeModel(saved.feeModel, feeEngineEnabled),
        estimatedRegistrations: saved.estimatedRegistrations ?? 100,
        whatsappEnabled:        saved.whatsappEnabled        ?? false,
        smsEnabled:             saved.smsEnabled             ?? false,
        certEnabled:            saved.certEnabled            ?? false,
      }
    }
    return {
      eventType:              'paid',
      feeModel:               SUPPORTED_FEE_MODEL,
      estimatedRegistrations: 100,
      passes:                 [],
      registrationOpenDate:   '',
      registrationEndDate:    '',
      showRemainingSeats:     true,
      whatsappEnabled:        false,
      smsEnabled:             false,
      certEnabled:            false,
      advancedSettings:       { taxes: [], fees: [], coupons: [], discounts: [] },
    }
  })
  const [advancedOpen,  setAdvancedOpen]  = useState(false)
  const [addPassOpen,   setAddPassOpen]   = useState(false)
  const [editingPass,   setEditingPass]   = useState<EventPass | null>(null)

  const updatePricing = (partial: Partial<EventPricingDraft>) =>
    setPricing(prev => ({ ...prev, ...partial }))

  const handleSavePass = (saved: EventPass) => {
    if (editingPass) {
      updatePricing({ passes: pricing.passes.map(p => p.id === saved.id ? saved : p) })
    } else {
      updatePricing({ passes: [...pricing.passes, saved] })
    }
    setEditingPass(null)
  }

  const handleEditPass = (pass: EventPass) => {
    setEditingPass(pass)
    setAddPassOpen(true)
  }

  const handleAddNew = () => {
    setEditingPass(null)
    setAddPassOpen(true)
  }

  useAutosaveEmit(pricing, onAutosave)   // RD-PRODUCT-01B: autosave passes/pricing as edited

  // RD-EVENT-05: this step had no `canProceed` — its rule was written inline at the footer
  // AND again on the warning below. One source now drives both.
  const canProceed = validateStep('pricing', { passCount: pricing.passes.length }).valid

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: EASE }}
      className="flex min-h-full flex-col"
    >

      {/* -- Back link -- */}
      <Link
        href={ROUTES.DASHBOARD}
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Back to Dashboard
      </Link>

      {/* -- Stepper -- */}
      <Stepper currentStep={currentStep} completedValues={completedValues} steps={wizardSteps ?? WIZARD_STEPS} />

      {/* -- Title -- */}
      <div className="mt-4">
        <h1 className="text-[22px] font-bold tracking-tight text-foreground">
          Passes &amp; Pricing
        </h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Configure your plan, ticket types, and registration schedule.
        </p>
      </div>

      {/* -- Main content -- */}
      <div className="mt-4 grid flex-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">

        {/* Left column — min-w-0 prevents the table from stretching the grid */}
        <div className="flex min-w-0 flex-col gap-5">

          {/* SECTION 1: RegisterDesk Plan */}
          <EventTypeSelectorSection
            value={pricing.eventType}
            onChange={v => updatePricing({ eventType: v })}
          />

          {/* SECTION 2: Ticket Types & Pricing */}
          {(() => {
            const hasUnlimitedPass = pricing.passes.some(p => p.unlimited)
            const totalCapacity    = hasUnlimitedPass
              ? null
              : pricing.passes.reduce((s, p) => s + (p.quantity ?? 0), 0)
            return (
          <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
            {/* Section header */}
            <div className="border-b border-border px-5 py-4 sm:px-6">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/[0.09]">
                    <Ticket className="size-4 text-primary" aria-hidden />
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-[15px] font-bold tracking-tight text-foreground">Ticket Types &amp; Pricing</p>
                      {hasUnlimitedPass ? (
                        <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[12px] font-semibold text-amber-700">
                          Unlimited Capacity
                        </span>
                      ) : totalCapacity != null && totalCapacity > 0 ? (
                        <span className="rounded-full bg-muted px-2.5 py-0.5 text-[12px] font-semibold text-muted-foreground">
                          {totalCapacity.toLocaleString('en-IN')} Attendees
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-[13px] text-muted-foreground">
                      Create ticket categories with different pricing and limits.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleAddNew}
                  className={cn(
                    buttonVariants({ variant: 'outline' }),
                    'shrink-0 gap-1.5 border-primary/30 text-primary hover:border-primary/60 hover:bg-primary/[0.03] text-[12px]',
                  )}
                >
                  <Plus className="size-3.5" aria-hidden />
                  Add Pass
                </button>
              </div>
            </div>

            {/* Passes table */}
            <div className="px-5 py-5 sm:px-6">
              <PassesSection
                passes={pricing.passes}
                isFreeEvent={pricing.eventType === 'free'}
                onUpdate={passes => updatePricing({ passes })}
                onAddNew={handleAddNew}
                onEdit={handleEditPass}
              />
            </div>

            {/* Spacer at bottom when section has content */}
            <div className="h-5" />
          </div>
            )
          })()}

          {/* SECTION 3: Registration Schedule */}
          <RegistrationPeriodSection
            draft={pricing}
            onUpdate={updatePricing}
          />

          {/* Advanced Settings */}
          <AdvancedSettingsSection
            isOpen={advancedOpen}
            onToggle={() => setAdvancedOpen(v => !v)}
          />

        </div>

        {/* Right column: summary panel */}
        <Step4SummaryPanel pricing={pricing} />

      </div>

      {!canProceed && (
        <p className="mt-4 text-center text-[13px] font-medium text-amber-600">
          At least one pass is required before continuing.
        </p>
      )}

      <WizardFooter
        onBack={onBack}
        onSaveDraft={() => onSaveDraft?.(pricing)}
        onNext={() => onNext('Passes & Pricing', pricing)}
        isNextDisabled={!canProceed}
        stepContext={(() => {
          const steps = wizardSteps ?? WIZARD_STEPS
          return `Step ${currentStep + 1} of ${steps.length} · ${steps[currentStep]?.name ?? ''}`
        })()}
      />

      {/* Add / Edit Pass editor overlay */}
      <AddPassEditor
        isOpen={addPassOpen}
        onClose={() => { setAddPassOpen(false); setEditingPass(null) }}
        onSave={handleSavePass}
        editingPass={editingPass}
        eventTypeId={eventTypeId}
        eventSubtype={eventSubtype}
        isFreeEvent={pricing.eventType === 'free'}
      />

    </motion.div>
  )
}
