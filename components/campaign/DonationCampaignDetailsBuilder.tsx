'use client'

import { useState, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertCircle, Building2, Calendar, Check,
  Heart, Image, Info, Link2, Mail, Phone,
  ShieldCheck, Upload, User, X,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import {
  type CampaignDetailsDraft,
  type CampaignDetailsError,
  type BeneficiaryType,
  BENEFICIARY_TYPE_LABELS,
  DONATION_SUBTYPE_LABELS,
  type DonationCampaignSubtype,
  makeBlankCampaignDetailsDraft,
  validateCampaignDetails,
} from '@/lib/campaigns/campaignDetailsConfig'

// ─── Constants ────────────────────────────────────────────────────────────────

const EASE = [0.22, 1, 0.36, 1] as const

const inputCls = 'h-9 w-full rounded-lg border border-border bg-background px-3 text-[14px] text-foreground placeholder:text-muted-foreground/60 outline-none transition-colors focus:border-primary/50 focus:ring-2 focus:ring-primary/20'
const labelCls = 'mb-1 block text-[13px] font-medium text-foreground'
const hintCls  = 'mt-1 text-[13px] text-muted-foreground'
const errCls   = 'mt-1 flex items-center gap-1 text-[12px] text-destructive'

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
    <p className={errCls}>
      <AlertCircle size={12} className="shrink-0" />
      {msg}
    </p>
  )
}

// ─── Beneficiary type chip ────────────────────────────────────────────────────

const BENEFICIARY_TYPES: BeneficiaryType[] = ['individual', 'organization', 'community', 'animal', 'environment']

function BeneficiaryTypeChip({ value, selected, onSelect }: { value: BeneficiaryType; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" onClick={onSelect}
      className={cn(
        'flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium transition-all duration-150',
        selected ? 'border-primary bg-primary/[0.07] text-primary' : 'border-border bg-card text-foreground/70 hover:border-primary/30',
      )}>
      {selected && <Check size={12} />}
      {BENEFICIARY_TYPE_LABELS[value]}
    </button>
  )
}

// ─── Campaign Basics Section ──────────────────────────────────────────────────

function BasicsSection({ draft, errors, onChange }: {
  draft: CampaignDetailsDraft
  errors: CampaignDetailsError
  onChange: (patch: Partial<CampaignDetailsDraft>) => void
}) {
  const storyLen = draft.basics.story.length
  return (
    <SectionCard title="Campaign Basics" icon={<Heart size={16} />}>
      <div className="space-y-4">
        <div>
          <label className={labelCls}>Campaign Title <span className="text-destructive">*</span></label>
          <input
            className={cn(inputCls, errors['basics.title'] && 'border-destructive focus:border-destructive focus:ring-destructive/20')}
            value={draft.basics.title}
            maxLength={120}
            placeholder="e.g. Help Rajan Fight Cancer"
            onChange={e => onChange({ basics: { ...draft.basics, title: e.target.value } })}
          />
          <div className="mt-1 flex items-center justify-between">
            <FieldError msg={errors['basics.title']} />
            <span className="text-[12px] text-muted-foreground">{draft.basics.title.length}/120</span>
          </div>
        </div>

        <div>
          <label className={labelCls}>Tagline <span className="text-muted-foreground text-[12px] font-normal">(optional)</span></label>
          <input
            className={inputCls}
            value={draft.basics.tagline}
            maxLength={160}
            placeholder="A short, compelling line about your cause"
            onChange={e => onChange({ basics: { ...draft.basics, tagline: e.target.value } })}
          />
          <div className="flex justify-end">
            <span className="text-[12px] text-muted-foreground">{draft.basics.tagline.length}/160</span>
          </div>
        </div>

        <div>
          <label className={labelCls}>Your Story <span className="text-destructive">*</span></label>
          <textarea
            rows={7}
            className={cn(
              'w-full rounded-lg border border-border bg-background px-3 py-2 text-[14px] text-foreground placeholder:text-muted-foreground/60 outline-none transition-colors focus:border-primary/50 focus:ring-2 focus:ring-primary/20 resize-none',
              errors['basics.story'] && 'border-destructive focus:border-destructive focus:ring-destructive/20',
            )}
            value={draft.basics.story}
            placeholder="Describe the cause, the impact, who benefits, and why it matters — at least 100 characters"
            onChange={e => onChange({ basics: { ...draft.basics, story: e.target.value } })}
          />
          <div className="mt-1 flex items-center justify-between">
            <FieldError msg={errors['basics.story']} />
            <span className={cn('text-[12px]', storyLen < 100 ? 'text-muted-foreground' : 'text-green-600 dark:text-green-400')}>
              {storyLen} chars{storyLen < 100 ? ` (${100 - storyLen} more to go)` : ' ✓'}
            </span>
          </div>
        </div>
      </div>
    </SectionCard>
  )
}

// ─── Cover Media Section ──────────────────────────────────────────────────────

function MediaSection({ draft, onChange }: {
  draft: CampaignDetailsDraft
  onChange: (patch: Partial<CampaignDetailsDraft>) => void
}) {
  return (
    <SectionCard title="Cover Image & Video" icon={<Image size={16} />}>
      <div className="space-y-4">
        <div>
          <label className={labelCls}>Cover Image URL</label>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground"><Link2 size={15} /></span>
            <input
              className={inputCls}
              value={draft.media.coverImageUrl ?? ''}
              placeholder="https://..."
              onChange={e => onChange({ media: { ...draft.media, coverImageUrl: e.target.value || null } })}
            />
          </div>
          <p className={hintCls}>Recommended: 1200×630 px, JPG or PNG</p>
        </div>

        <div>
          <label className={labelCls}>Promo Video URL <span className="text-muted-foreground text-[12px] font-normal">(optional)</span></label>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground"><Link2 size={15} /></span>
            <input
              className={inputCls}
              value={draft.media.promoVideoUrl ?? ''}
              placeholder="YouTube or Vimeo link"
              onChange={e => onChange({ media: { ...draft.media, promoVideoUrl: e.target.value || null } })}
            />
          </div>
        </div>
      </div>
    </SectionCard>
  )
}

// ─── Cause & Beneficiary Section ──────────────────────────────────────────────

function BeneficiarySection({ draft, errors, onChange }: {
  draft: CampaignDetailsDraft
  errors: CampaignDetailsError
  onChange: (patch: Partial<CampaignDetailsDraft>) => void
}) {
  return (
    <SectionCard title="Cause & Beneficiary" icon={<User size={16} />}>
      <div className="space-y-4">
        <div>
          <label className={labelCls}>Beneficiary Name <span className="text-destructive">*</span></label>
          <input
            className={cn(inputCls, errors['beneficiary.name'] && 'border-destructive')}
            value={draft.beneficiary.name}
            placeholder="Name of person, organization, or community"
            onChange={e => onChange({ beneficiary: { ...draft.beneficiary, name: e.target.value } })}
          />
          <FieldError msg={errors['beneficiary.name']} />
        </div>

        <div>
          <label className={labelCls}>Beneficiary Type</label>
          <div className="mt-2 flex flex-wrap gap-2">
            {BENEFICIARY_TYPES.map(t => (
              <BeneficiaryTypeChip key={t} value={t} selected={draft.beneficiary.type === t}
                onSelect={() => onChange({ beneficiary: { ...draft.beneficiary, type: t } })} />
            ))}
          </div>
        </div>

        <div>
          <label className={labelCls}>Brief Description <span className="text-muted-foreground text-[12px] font-normal">(optional)</span></label>
          <textarea rows={3} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[14px] text-foreground placeholder:text-muted-foreground/60 outline-none transition-colors focus:border-primary/50 focus:ring-2 focus:ring-primary/20 resize-none"
            value={draft.beneficiary.description}
            placeholder="A little more about the beneficiary"
            onChange={e => onChange({ beneficiary: { ...draft.beneficiary, description: e.target.value } })}
          />
        </div>

        <div className="rounded-lg border border-border/60 bg-muted/30 p-3 space-y-3">
          <p className="text-[13px] font-medium text-foreground/80">If supported by an NGO (optional)</p>
          <div>
            <label className={cn(labelCls, 'text-[12px]')}>NGO Name</label>
            <input className={inputCls} value={draft.beneficiary.ngoName}
              placeholder="Registered NGO name"
              onChange={e => onChange({ beneficiary: { ...draft.beneficiary, ngoName: e.target.value } })} />
          </div>
          <div>
            <label className={cn(labelCls, 'text-[12px]')}>NGO Registration Number</label>
            <input className={inputCls} value={draft.beneficiary.ngoRegistrationNo}
              placeholder="e.g. MH/2010/12345"
              onChange={e => onChange({ beneficiary: { ...draft.beneficiary, ngoRegistrationNo: e.target.value } })} />
          </div>
        </div>
      </div>
    </SectionCard>
  )
}

// ─── Campaign Goal Section ────────────────────────────────────────────────────

function GoalSection({ draft, errors, onChange }: {
  draft: CampaignDetailsDraft
  errors: CampaignDetailsError
  onChange: (patch: Partial<CampaignDetailsDraft>) => void
}) {
  return (
    <SectionCard title="Campaign Goal" icon={<Calendar size={16} />}>
      <div className="space-y-4">
        <div>
          <label className={labelCls}>Fundraising Goal (₹) <span className="text-destructive">*</span></label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[14px] text-muted-foreground">₹</span>
            <input
              type="number"
              min={1000}
              step={1000}
              className={cn(inputCls, 'pl-7', errors['goal.targetAmountRupees'] && 'border-destructive')}
              value={draft.goal.targetAmountRupees ?? ''}
              placeholder="10000"
              onChange={e => onChange({ goal: { ...draft.goal, targetAmountRupees: e.target.value ? Number(e.target.value) : null } })}
            />
          </div>
          <FieldError msg={errors['goal.targetAmountRupees']} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Start Date</label>
            <input type="date" className={cn(inputCls, errors['goal.startDate'] && 'border-destructive')}
              value={draft.goal.startDate}
              onChange={e => onChange({ goal: { ...draft.goal, startDate: e.target.value } })} />
            <FieldError msg={errors['goal.startDate']} />
          </div>
          <div>
            <label className={labelCls}>End Date <span className="text-destructive">*</span></label>
            <input type="date" className={cn(inputCls, errors['goal.endDate'] && 'border-destructive')}
              value={draft.goal.endDate}
              onChange={e => onChange({ goal: { ...draft.goal, endDate: e.target.value } })} />
            <FieldError msg={errors['goal.endDate']} />
          </div>
        </div>

        <div className="space-y-3 pt-1">
          <Toggle
            checked={draft.goal.allowOverFunding}
            onChange={v => onChange({ goal: { ...draft.goal, allowOverFunding: v } })}
            label="Allow over-funding"
            desc="Continue accepting donations after the goal is reached"
          />
          <Toggle
            checked={draft.goal.showGoalAmount}
            onChange={v => onChange({ goal: { ...draft.goal, showGoalAmount: v } })}
            label="Show goal amount publicly"
            desc="Display the target amount on the campaign page"
          />
        </div>
      </div>
    </SectionCard>
  )
}

// ─── Organizer Info Section ───────────────────────────────────────────────────

function OrganizerSection({ draft, errors, onChange }: {
  draft: CampaignDetailsDraft
  errors: CampaignDetailsError
  onChange: (patch: Partial<CampaignDetailsDraft>) => void
}) {
  return (
    <SectionCard title="Organizer Info" icon={<Building2 size={16} />}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls}>Name <span className="text-destructive">*</span></label>
            <input className={cn(inputCls, errors['organizer.name'] && 'border-destructive')}
              value={draft.organizer.name}
              placeholder="Your name or organization"
              onChange={e => onChange({ organizer: { ...draft.organizer, name: e.target.value } })} />
            <FieldError msg={errors['organizer.name']} />
          </div>
          <div>
            <label className={labelCls}>Email <span className="text-destructive">*</span></label>
            <div className="relative">
              <Mail size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input className={cn(inputCls, 'pl-8', errors['organizer.email'] && 'border-destructive')}
                type="email" value={draft.organizer.email} placeholder="you@example.com"
                onChange={e => onChange({ organizer: { ...draft.organizer, email: e.target.value } })} />
            </div>
            <FieldError msg={errors['organizer.email']} />
          </div>
          <div>
            <label className={labelCls}>Phone</label>
            <div className="relative">
              <Phone size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input className={cn(inputCls, 'pl-8', errors['organizer.phone'] && 'border-destructive')}
                type="tel" value={draft.organizer.phone} placeholder="9XXXXXXXXX"
                onChange={e => onChange({ organizer: { ...draft.organizer, phone: e.target.value } })} />
            </div>
            <FieldError msg={errors['organizer.phone']} />
          </div>
          <div>
            <label className={labelCls}>Website</label>
            <input className={cn(inputCls, errors['organizer.website'] && 'border-destructive')}
              type="url" value={draft.organizer.website} placeholder="https://example.com"
              onChange={e => onChange({ organizer: { ...draft.organizer, website: e.target.value } })} />
            <FieldError msg={errors['organizer.website']} />
          </div>
        </div>
      </div>
    </SectionCard>
  )
}

// ─── 80G Tax Compliance Section ───────────────────────────────────────────────

function TaxSection({ draft, errors, onChange }: {
  draft: CampaignDetailsDraft
  errors: CampaignDetailsError
  onChange: (patch: Partial<CampaignDetailsDraft>) => void
}) {
  const enabled = draft.taxConfig.enabled

  return (
    <SectionCard title="80G Tax Compliance" icon={<ShieldCheck size={16} />}>
      <div className="space-y-4">
        <Toggle
          checked={enabled}
          onChange={v => onChange({ taxConfig: { ...draft.taxConfig, enabled: v } })}
          label="Enable 80G tax exemption"
          desc="Donors can claim deductions under Section 80G of the Income Tax Act"
        />

        <AnimatePresence>
          {enabled && (
            <motion.div
              key="80g-fields"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.22, ease: EASE }}
              className="overflow-hidden"
            >
              <div className="space-y-4 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800/40 dark:bg-amber-950/20">
                <div className="flex items-start gap-2 text-amber-700 dark:text-amber-400">
                  <Info size={14} className="mt-0.5 shrink-0" />
                  <p className="text-[13px]">All 80G fields are required for publishing. Incomplete 80G data will block the campaign from going live.</p>
                </div>

                <div>
                  <label className={cn(labelCls, 'text-[12px]')}>Organization PAN <span className="text-destructive">*</span></label>
                  <input
                    className={cn(inputCls, 'uppercase', errors['taxConfig.organizationPan'] && 'border-destructive')}
                    value={draft.taxConfig.organizationPan}
                    maxLength={10}
                    placeholder="ABCDE1234F"
                    onChange={e => onChange({ taxConfig: { ...draft.taxConfig, organizationPan: e.target.value.toUpperCase() } })}
                  />
                  <FieldError msg={errors['taxConfig.organizationPan']} />
                </div>

                <div>
                  <label className={cn(labelCls, 'text-[12px]')}>80G Registration Number <span className="text-destructive">*</span></label>
                  <input
                    className={cn(inputCls, errors['taxConfig.registrationNumber'] && 'border-destructive')}
                    value={draft.taxConfig.registrationNumber}
                    placeholder="e.g. AADTM2345GF20211"
                    onChange={e => onChange({ taxConfig: { ...draft.taxConfig, registrationNumber: e.target.value } })}
                  />
                  <FieldError msg={errors['taxConfig.registrationNumber']} />
                </div>

                <div>
                  <label className={cn(labelCls, 'text-[12px]')}>Certificate Expiry Date <span className="text-destructive">*</span></label>
                  <input
                    type="date"
                    className={cn(inputCls, errors['taxConfig.certificateExpiry'] && 'border-destructive')}
                    value={draft.taxConfig.certificateExpiry}
                    onChange={e => onChange({ taxConfig: { ...draft.taxConfig, certificateExpiry: e.target.value } })}
                  />
                  <FieldError msg={errors['taxConfig.certificateExpiry']} />
                </div>

                <div>
                  <label className={cn(labelCls, 'text-[12px]')}>80G Certificate <span className="text-destructive">*</span></label>
                  {draft.taxConfig.certificateUrl ? (
                    <div className="flex items-center gap-2 rounded-lg border border-green-300 bg-green-50 px-3 py-2 dark:border-green-800 dark:bg-green-950/20">
                      <Check size={14} className="text-green-600 dark:text-green-400" />
                      <span className="flex-1 truncate text-[13px] text-green-700 dark:text-green-400">Certificate uploaded</span>
                      <button type="button"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => onChange({ taxConfig: { ...draft.taxConfig, certificateUrl: null } })}>
                        <X size={14} />
                      </button>
                    </div>
                  ) : (
                    <div className={cn('flex cursor-pointer items-center gap-2 rounded-lg border-2 border-dashed px-3 py-4 text-center transition-colors hover:bg-muted/30', errors['taxConfig.certificateUrl'] ? 'border-destructive' : 'border-border')}>
                      <Upload size={16} className="mx-auto text-muted-foreground" />
                      <span className="text-[13px] text-muted-foreground">Upload 80G certificate (PDF/JPG)</span>
                    </div>
                  )}
                  <FieldError msg={errors['taxConfig.certificateUrl']} />
                  <p className={hintCls}>Certificate upload to storage is handled separately; paste the URL here during development.</p>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </SectionCard>
  )
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface DonationCampaignDetailsBuilderProps {
  draft:    CampaignDetailsDraft
  onChange: (patch: Partial<CampaignDetailsDraft>) => void
  /** If true, shows inline validation errors (only after user tries to advance). */
  showErrors?: boolean
}

export function DonationCampaignDetailsBuilder({ draft, onChange, showErrors = false }: DonationCampaignDetailsBuilderProps) {
  const errors = showErrors ? validateCampaignDetails(draft) : {}

  return (
    <div className="space-y-4">
      <BasicsSection     draft={draft} errors={errors} onChange={onChange} />
      <MediaSection      draft={draft}                 onChange={onChange} />
      <BeneficiarySection draft={draft} errors={errors} onChange={onChange} />
      <GoalSection       draft={draft} errors={errors} onChange={onChange} />
      <OrganizerSection  draft={draft} errors={errors} onChange={onChange} />
      <TaxSection        draft={draft} errors={errors} onChange={onChange} />
    </div>
  )
}
