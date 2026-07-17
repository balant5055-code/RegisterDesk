'use client'

import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertCircle, Bell, Check, Heart, MessageSquare, Plus, Trash2, Users } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import {
  type DonationSettingsDraft,
  type DonationSettingsError,
  validateDonationSettings,
} from '@/lib/campaigns/donationSettingsConfig'

// ─── Constants ────────────────────────────────────────────────────────────────

const EASE = [0.22, 1, 0.36, 1] as const

const inputCls = 'h-9 w-full rounded-lg border border-border bg-background px-3 text-[14px] text-foreground placeholder:text-muted-foreground/60 outline-none transition-colors focus:border-primary/50 focus:ring-2 focus:ring-primary/20'
const labelCls = 'mb-1 block text-[13px] font-medium text-foreground'
const hintCls  = 'mt-1 text-[13px] text-muted-foreground'

const MILESTONE_PRESETS = [25, 50, 75, 100]

// ─── Shared primitives ────────────────────────────────────────────────────────

function SectionCard({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="mb-4 flex items-center gap-2">
        {icon && <span className="text-primary">{icon}</span>}
        <p className="text-[15px] font-semibold text-foreground">{title}</p>
      </div>
      {children}
    </div>
  )
}

function Toggle({ checked, onChange, label, desc }: { checked: boolean; onChange: (v: boolean) => void; label: string; desc?: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[14px] font-medium text-foreground">{label}</p>
        {desc && <p className="text-[13px] leading-snug text-muted-foreground">{desc}</p>}
      </div>
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
        className={cn('relative inline-flex h-[22px] w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200', checked ? 'bg-primary' : 'bg-muted-foreground/30')}>
        <span className={cn('inline-block size-[18px] rounded-full bg-white shadow-sm transition-transform duration-200', checked ? 'translate-x-[18px]' : 'translate-x-0')} />
      </button>
    </div>
  )
}

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null
  return (
    <p className="mt-1 flex items-center gap-1 text-[12px] text-destructive">
      <AlertCircle size={12} className="shrink-0" />
      {msg}
    </p>
  )
}

// ─── Suggested Amount Chip ────────────────────────────────────────────────────

function AmountChip({ value, onRemove }: { value: number; onRemove: () => void }) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.8 }}
      transition={{ duration: 0.15, ease: EASE }}
      className="flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/[0.06] px-3 py-1 text-[13px] font-medium text-primary"
    >
      ₹{value.toLocaleString('en-IN')}
      <button type="button" onClick={onRemove} className="rounded-full text-primary/60 hover:text-destructive transition-colors">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M9 3L3 9M3 3l6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </motion.div>
  )
}

// ─── Donation Amounts Section ─────────────────────────────────────────────────

function AmountsSection({ draft, errors, onChange }: {
  draft: DonationSettingsDraft
  errors: DonationSettingsError
  onChange: (patch: Partial<DonationSettingsDraft>) => void
}) {
  const [newAmtStr, setNewAmtStr] = useState('')

  const amounts = draft.amounts

  function addAmount() {
    const val = parseInt(newAmtStr, 10)
    if (!val || val < 1) return
    if (amounts.suggestedAmountsRupees.includes(val)) { setNewAmtStr(''); return }
    const next = [...amounts.suggestedAmountsRupees, val].sort((a, b) => a - b)
    onChange({ amounts: { ...amounts, suggestedAmountsRupees: next } })
    setNewAmtStr('')
  }

  function removeAmount(idx: number) {
    const next = amounts.suggestedAmountsRupees.filter((_, i) => i !== idx)
    onChange({ amounts: { ...amounts, suggestedAmountsRupees: next } })
  }

  return (
    <SectionCard title="Donation Amounts" icon={<Heart size={16} />}>
      <div className="space-y-4">
        <div>
          <label className={labelCls}>Suggested Amounts</label>
          <div className="min-h-[40px] flex flex-wrap gap-2 rounded-lg border border-border bg-background p-2">
            <AnimatePresence mode="popLayout">
              {amounts.suggestedAmountsRupees.map((amt, i) => (
                <AmountChip key={amt} value={amt} onRemove={() => removeAmount(i)} />
              ))}
            </AnimatePresence>
          </div>
          {amounts.suggestedAmountsRupees.length < 6 && (
            <div className="mt-2 flex gap-2">
              <div className="relative flex-1">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[14px] text-muted-foreground">₹</span>
                <input
                  className={cn(inputCls, 'pl-7')}
                  type="number" min={1} value={newAmtStr}
                  placeholder="e.g. 2000"
                  onChange={e => setNewAmtStr(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addAmount() } }}
                />
              </div>
              <button type="button" onClick={addAmount}
                className="flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-[13px] font-medium text-foreground hover:bg-muted/50 transition-colors">
                <Plus size={14} /> Add
              </button>
            </div>
          )}
          <FieldError msg={errors['amounts.suggestedAmountsRupees']} />
          <FieldError msg={errors['amounts.noAmounts']} />
          <p className={hintCls}>Up to 6 amounts. Donors can also choose their own if custom amounts are enabled.</p>
        </div>

        <Toggle
          checked={amounts.allowCustomAmount}
          onChange={v => onChange({ amounts: { ...amounts, allowCustomAmount: v } })}
          label="Allow custom amount"
          desc="Let donors enter any amount they want"
        />

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Minimum Donation (₹)</label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[14px] text-muted-foreground">₹</span>
              <input
                type="number" min={1} step={1}
                className={cn(inputCls, 'pl-7', errors['amounts.minimumAmountRupees'] && 'border-destructive')}
                value={amounts.minimumAmountRupees}
                onChange={e => onChange({ amounts: { ...amounts, minimumAmountRupees: Number(e.target.value) || 1 } })}
              />
            </div>
            <FieldError msg={errors['amounts.minimumAmountRupees']} />
          </div>

          <div>
            <label className={labelCls}>Maximum Donation (₹) <span className="text-[12px] font-normal text-muted-foreground">optional</span></label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[14px] text-muted-foreground">₹</span>
              <input
                type="number" min={1} step={1000}
                className={cn(inputCls, 'pl-7', errors['amounts.maximumAmountRupees'] && 'border-destructive')}
                value={amounts.maximumAmountRupees ?? ''}
                placeholder="No limit"
                onChange={e => onChange({ amounts: { ...amounts, maximumAmountRupees: e.target.value ? Number(e.target.value) : null } })}
              />
            </div>
            <FieldError msg={errors['amounts.maximumAmountRupees']} />
          </div>
        </div>
      </div>
    </SectionCard>
  )
}

// ─── Donor Experience Section ─────────────────────────────────────────────────

function DonorExperienceSection({ draft, onChange }: {
  draft: DonationSettingsDraft
  onChange: (patch: Partial<DonationSettingsDraft>) => void
}) {
  const dx = draft.donorExperience

  function patch(partial: Partial<typeof dx>) {
    onChange({ donorExperience: { ...dx, ...partial } })
  }

  return (
    <SectionCard title="Donor Experience" icon={<Users size={16} />}>
      <div className="space-y-4">
        <div className="space-y-3">
          <Toggle checked={dx.allowAnonymous}   onChange={v => patch({ allowAnonymous: v })}   label="Allow anonymous donations"    desc="Donors can hide their name from the public feed" />
          <Toggle checked={dx.allowDedications} onChange={v => patch({ allowDedications: v })} label="Allow dedications"            desc="Donors can dedicate their gift to someone" />
          <Toggle checked={dx.allowMessages}    onChange={v => patch({ allowMessages: v })}    label="Allow messages"               desc="Donors can leave a message with their donation" />
          <Toggle checked={dx.showDonorNames}   onChange={v => patch({ showDonorNames: v })}   label="Show donor names publicly"    desc="Display names in the recent donors feed" />
          <Toggle checked={dx.showDonorCount}   onChange={v => patch({ showDonorCount: v })}   label="Show donor count"             desc="Show the total number of donors on the campaign page" />
        </div>

        <div>
          <label className={labelCls}>Thank-you Message <span className="text-[12px] font-normal text-muted-foreground">optional</span></label>
          <textarea rows={3}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[14px] text-foreground placeholder:text-muted-foreground/60 outline-none transition-colors focus:border-primary/50 focus:ring-2 focus:ring-primary/20 resize-none"
            value={dx.thankYouMessage}
            placeholder="Thank you so much for your generous support! Every rupee brings us closer to our goal."
            onChange={e => patch({ thankYouMessage: e.target.value })}
          />
          <p className={hintCls}>Shown on the post-donation confirmation page.</p>
        </div>
      </div>
    </SectionCard>
  )
}

// ─── Notifications Section ────────────────────────────────────────────────────

function NotificationsSection({ draft, onChange }: {
  draft: DonationSettingsDraft
  onChange: (patch: Partial<DonationSettingsDraft>) => void
}) {
  const notifs = draft.notifications

  function toggleMilestone(pct: number) {
    const current = notifs.milestoneAlerts
    const next    = current.includes(pct) ? current.filter(p => p !== pct) : [...current, pct].sort((a, b) => a - b)
    onChange({ notifications: { ...notifs, milestoneAlerts: next } })
  }

  return (
    <SectionCard title="Notifications" icon={<Bell size={16} />}>
      <div className="space-y-4">
        <Toggle
          checked={notifs.onEveryDonation}
          onChange={v => onChange({ notifications: { ...notifs, onEveryDonation: v } })}
          label="Notify on every donation"
          desc="Receive an email each time someone donates"
        />

        <div>
          <label className={labelCls}>Milestone alerts</label>
          <p className={hintCls}>Get notified when you hit these % of your goal</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {MILESTONE_PRESETS.map(pct => {
              const active = notifs.milestoneAlerts.includes(pct)
              return (
                <button key={pct} type="button" onClick={() => toggleMilestone(pct)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium transition-all duration-150',
                    active ? 'border-primary bg-primary/[0.07] text-primary' : 'border-border bg-card text-foreground/70 hover:border-primary/30',
                  )}>
                  {active && <Check size={12} />}
                  {pct}%
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </SectionCard>
  )
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface DonationSettingsBuilderProps {
  draft:      DonationSettingsDraft
  onChange:   (patch: Partial<DonationSettingsDraft>) => void
  showErrors?: boolean
}

export function DonationSettingsBuilder({ draft, onChange, showErrors = false }: DonationSettingsBuilderProps) {
  const errors = showErrors ? validateDonationSettings(draft) : {}

  return (
    <div className="space-y-4">
      <AmountsSection         draft={draft} errors={errors} onChange={onChange} />
      <DonorExperienceSection draft={draft}                 onChange={onChange} />
      <NotificationsSection   draft={draft}                 onChange={onChange} />
    </div>
  )
}
