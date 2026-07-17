'use client'

// Wizard step 6 (for event_plus_donation events) — fundraising campaign setup.
// Collects: story, goal amount, end date, 80G config, donation amounts.
// Title, organizer info, and cover image are auto-derived from the event at publish time.

import { useState } from 'react'
import { motion }   from 'framer-motion'
import {
  Heart, IndianRupee, Calendar, Shield, Info, ChevronDown, ChevronUp, Plus, X, AlertTriangle,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { WizardFooter } from './WizardFooter'
import {
  type LinkedCampaignDraft,
  type LinkedCampaignError,
  makeBlankLinkedCampaignDraft,
  validateLinkedCampaign,
  validateLinkedCampaignCore,
  isLinkedCampaignNavigationValid,
} from '@/lib/campaigns/linkedCampaignConfig'

// Mirrors WizardStep in page.tsx (not exported from there)
interface WizardStep { name: string }

const EASE = [0.22, 1, 0.36, 1] as const

interface LinkedCampaignStepProps {
  currentStep:     number
  completedValues: (string | undefined)[]
  onNext:          (label?: string, data?: unknown) => void
  onBack:          () => void
  onSaveDraft?:    (data?: unknown) => void
  initialData?:    Record<string, unknown> | null
  wizardSteps?:    WizardStep[]
}

const DEFAULT_SUGGESTIONS = [100, 500, 1000, 5000]

function fmtINR(rupees: number): string {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(rupees)
}

function minDateFromToday(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}

// ─── Stepper (minimal inline version) ────────────────────────────────────────

function Stepper({
  currentStep,
  completedValues,
  steps,
}: {
  currentStep:     number
  completedValues: (string | undefined)[]
  steps:           WizardStep[]
}) {
  return (
    <div className="mb-6 flex items-center gap-1 overflow-x-auto pb-1">
      {steps.map((step, i) => {
        const done    = completedValues[i] != null
        const active  = i === currentStep
        const future  = i > currentStep && !done
        return (
          <div key={i} className="flex shrink-0 items-center gap-1">
            <div className={cn(
              'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold',
              active ? 'bg-primary text-white' :
              done   ? 'bg-primary/20 text-primary' :
              'bg-muted text-muted-foreground',
            )}>
              {done && !active ? '✓' : i + 1}
            </div>
            <span className={cn(
              'text-[12px] whitespace-nowrap',
              active ? 'font-semibold text-foreground' :
              done   ? 'text-primary' :
              future ? 'text-muted-foreground' : 'text-muted-foreground',
            )}>
              {step.name}
            </span>
            {i < steps.length - 1 && (
              <div className={cn('mx-1 h-px w-4 shrink-0', done ? 'bg-primary/40' : 'bg-border')} />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function LinkedCampaignStep({
  currentStep,
  completedValues,
  onNext,
  onBack,
  onSaveDraft,
  initialData,
  wizardSteps = [],
}: LinkedCampaignStepProps) {
  const raw  = initialData?.linkedCampaign as LinkedCampaignDraft | null | undefined
  const init: LinkedCampaignDraft = raw ?? makeBlankLinkedCampaignDraft()

  const [draft,      setDraft]      = useState<LinkedCampaignDraft>(init)
  const [errors,     setErrors]     = useState<LinkedCampaignError>({})
  const [showErrors, setShowErrors] = useState(false)
  const [showTax,    setShowTax]    = useState(init.taxConfig.enabled)
  const [newAmt,     setNewAmt]     = useState('')

  const eventEndDate = (initialData?.eventEndDate as string | null | undefined) ?? ''

  function update(patch: Partial<LinkedCampaignDraft>) {
    setDraft(prev => ({ ...prev, ...patch }))
  }

  function updateGoal(patch: Partial<LinkedCampaignDraft['goal']>) {
    setDraft(prev => ({ ...prev, goal: { ...prev.goal, ...patch } }))
  }

  function updateTax(patch: Partial<LinkedCampaignDraft['taxConfig']>) {
    setDraft(prev => ({ ...prev, taxConfig: { ...prev.taxConfig, ...patch } }))
  }

  function updateAmounts(patch: Partial<LinkedCampaignDraft['donationSettings']['amounts']>) {
    setDraft(prev => ({
      ...prev,
      donationSettings: {
        ...prev.donationSettings,
        amounts: { ...prev.donationSettings.amounts, ...patch },
      },
    }))
  }

  function addSuggestion() {
    const val = parseInt(newAmt.replace(/[^\d]/g, ''), 10)
    if (!val || val < 1) return
    const existing = draft.donationSettings.amounts.suggestedAmountsRupees
    if (existing.includes(val) || existing.length >= 6) return
    const sorted = [...existing, val].sort((a, b) => a - b)
    updateAmounts({ suggestedAmountsRupees: sorted })
    setNewAmt('')
  }

  function removeSuggestion(val: number) {
    updateAmounts({
      suggestedAmountsRupees: draft.donationSettings.amounts.suggestedAmountsRupees.filter(v => v !== val),
    })
  }

  function handleNext() {
    const coreErrs = validateLinkedCampaignCore(draft)
    // Show all field errors (including 80G) so user knows what to fix before publishing
    setErrors(validateLinkedCampaign(draft))
    setShowErrors(true)
    // Only block navigation on core (non-80G) errors
    if (Object.keys(coreErrs).length > 0) return
    onNext?.('Fundraising', draft)
  }

  // WizardFooter.onSaveDraft is () => void; wrap to pass draft data upward
  function handleSave() {
    onSaveDraft?.(draft)
  }

  const minGoalDate = minDateFromToday(7)
  const maxDate     = eventEndDate && eventEndDate >= minGoalDate ? eventEndDate : ''

  const stepContext = wizardSteps.length > 0
    ? `Step ${currentStep + 1} of ${wizardSteps.length} · ${wizardSteps[currentStep]?.name ?? 'Fundraising'}`
    : `Step ${currentStep + 1} · Fundraising`

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: EASE }}
      className="flex min-h-full flex-col gap-5 pt-1"
    >
      {wizardSteps.length > 0 && (
        <Stepper currentStep={currentStep} completedValues={completedValues} steps={wizardSteps} />
      )}

      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-pink-100">
          <Heart className="size-5 text-pink-500" />
        </div>
        <div>
          <h2 className="text-[18px] font-bold text-foreground">Fundraising Campaign</h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Attach a donation campaign to this event. Donations flow through your existing donation infrastructure.
          </p>
        </div>
      </div>

      {/* Story */}
      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <label className="mb-2 block text-[14px] font-semibold text-foreground">
          How will donations be used? <span className="text-destructive">*</span>
        </label>
        <textarea
          rows={5}
          maxLength={2000}
          value={draft.story}
          onChange={e => update({ story: e.target.value })}
          placeholder="Tell donors how the funds raised through this event will make a difference. Be specific about impact."
          className={cn(
            'w-full resize-none rounded-xl border bg-background px-3.5 py-2.5 text-[14px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary',
            errors['story'] ? 'border-destructive focus:ring-destructive' : 'border-border',
          )}
        />
        <div className="mt-1 flex items-start justify-between gap-2">
          {errors['story'] ? (
            <p className="text-[12px] text-destructive">{errors['story']}</p>
          ) : (
            <p className="text-[12px] text-muted-foreground">Minimum 100 characters</p>
          )}
          <p className="shrink-0 text-[12px] text-muted-foreground">{draft.story.length} / 2000</p>
        </div>
      </div>

      {/* Goal */}
      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <p className="mb-3 text-[14px] font-semibold text-foreground">Fundraising Goal</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {/* Target amount */}
          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-foreground">
              Target Amount <span className="text-destructive">*</span>
            </label>
            <div className="relative">
              <IndianRupee className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="number"
                min={1000}
                value={draft.goal.targetAmountRupees ?? ''}
                onChange={e => updateGoal({ targetAmountRupees: e.target.value ? Number(e.target.value) : null })}
                placeholder="50000"
                className={cn(
                  'w-full rounded-xl border bg-background py-2.5 pl-9 pr-3.5 text-[14px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary',
                  errors['goal.targetAmountRupees'] ? 'border-destructive' : 'border-border',
                )}
              />
            </div>
            {errors['goal.targetAmountRupees'] && (
              <p className="mt-1 text-[12px] text-destructive">{errors['goal.targetAmountRupees']}</p>
            )}
          </div>

          {/* End date */}
          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-foreground">
              Campaign End Date <span className="text-destructive">*</span>
            </label>
            <div className="relative">
              <Calendar className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="date"
                min={minGoalDate}
                max={maxDate || undefined}
                value={draft.goal.endDate}
                onChange={e => updateGoal({ endDate: e.target.value })}
                className={cn(
                  'w-full rounded-xl border bg-background py-2.5 pl-9 pr-3.5 text-[14px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary',
                  errors['goal.endDate'] ? 'border-destructive' : 'border-border',
                )}
              />
            </div>
            {errors['goal.endDate'] ? (
              <p className="mt-1 text-[12px] text-destructive">{errors['goal.endDate']}</p>
            ) : (
              <p className="mt-1 text-[12px] text-muted-foreground">Defaults to event end date</p>
            )}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-4">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={draft.goal.allowOverFunding}
              onChange={e => updateGoal({ allowOverFunding: e.target.checked })}
              className="size-4 rounded border-border accent-primary"
            />
            <span className="text-[13px] text-foreground">Accept donations past the goal</span>
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={draft.goal.showGoalAmount}
              onChange={e => updateGoal({ showGoalAmount: e.target.checked })}
              className="size-4 rounded border-border accent-primary"
            />
            <span className="text-[13px] text-foreground">Show goal amount publicly</span>
          </label>
        </div>
      </div>

      {/* Donation amounts */}
      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <p className="mb-3 text-[14px] font-semibold text-foreground">Suggested Donation Amounts</p>
        <div className="mb-3 flex flex-wrap gap-2">
          {draft.donationSettings.amounts.suggestedAmountsRupees.map(val => (
            <span
              key={val}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/50 px-3 py-1.5 text-[13px] font-medium text-foreground"
            >
              ₹{fmtINR(val)}
              <button
                type="button"
                onClick={() => removeSuggestion(val)}
                className="ml-0.5 text-muted-foreground hover:text-destructive"
                aria-label={`Remove ₹${val}`}
              >
                <X className="size-3.5" />
              </button>
            </span>
          ))}
          {draft.donationSettings.amounts.suggestedAmountsRupees.length < 6 && (
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={1}
                value={newAmt}
                onChange={e => setNewAmt(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addSuggestion()}
                placeholder="Add amount"
                className="w-28 rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <button
                type="button"
                onClick={addSuggestion}
                disabled={!newAmt}
                className="flex size-7 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground hover:bg-muted/80 disabled:opacity-40"
              >
                <Plus className="size-3.5" />
              </button>
            </div>
          )}
        </div>
        {draft.donationSettings.amounts.suggestedAmountsRupees.length === 0 && (
          <div className="mb-3 flex gap-2">
            {DEFAULT_SUGGESTIONS.map(v => (
              <button
                key={v}
                type="button"
                onClick={() => updateAmounts({ suggestedAmountsRupees: [v] })}
                className="rounded-lg border border-dashed border-primary/40 px-3 py-1.5 text-[12px] text-primary hover:bg-primary/5"
              >
                ₹{fmtINR(v)}
              </button>
            ))}
          </div>
        )}
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={draft.donationSettings.amounts.allowCustomAmount}
            onChange={e => updateAmounts({ allowCustomAmount: e.target.checked })}
            className="size-4 rounded border-border accent-primary"
          />
          <span className="text-[13px] text-foreground">Allow custom amount</span>
        </label>
      </div>

      {/* 80G Tax Config — collapsible */}
      <div className="rounded-xl border border-border bg-card shadow-sm">
        <button
          type="button"
          onClick={() => setShowTax(v => !v)}
          className="flex w-full items-center justify-between px-4 py-3.5"
        >
          <div className="flex items-center gap-2">
            <Shield className="size-4 text-muted-foreground" />
            <span className="text-[14px] font-semibold text-foreground">80G Tax Exemption</span>
            {draft.taxConfig.enabled && (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                Enabled
              </span>
            )}
          </div>
          {showTax ? <ChevronUp className="size-4 text-muted-foreground" /> : <ChevronDown className="size-4 text-muted-foreground" />}
        </button>

        {showTax && (
          <div className="space-y-3 border-t border-border p-4">
            <div className="flex items-start gap-2 rounded-xl bg-blue-50 p-3 text-[13px] text-blue-800 dark:bg-blue-950/20 dark:text-blue-300">
              <Info className="mt-0.5 size-4 shrink-0" />
              Donors who give to 80G-registered organizations may be eligible for tax deductions under Section 80G of the Income Tax Act.
            </div>

            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={draft.taxConfig.enabled}
                onChange={e => updateTax({ enabled: e.target.checked })}
                className="size-4 rounded border-border accent-primary"
              />
              <span className="text-[13px] font-medium text-foreground">This campaign is eligible for 80G tax receipts</span>
            </label>

            {draft.taxConfig.enabled && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-[13px] font-medium text-foreground">
                    Organization PAN <span className="text-destructive">*</span>
                  </label>
                  <input
                    type="text"
                    maxLength={10}
                    value={draft.taxConfig.organizationPan}
                    onChange={e => updateTax({ organizationPan: e.target.value.toUpperCase() })}
                    placeholder="ABCDE1234F"
                    className={cn(
                      'w-full rounded-xl border bg-background px-3.5 py-2.5 font-mono text-[14px] uppercase text-foreground placeholder:normal-case placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary',
                      errors['taxConfig.organizationPan'] ? 'border-destructive' : 'border-border',
                    )}
                  />
                  {errors['taxConfig.organizationPan'] && (
                    <p className="mt-1 text-[12px] text-destructive">{errors['taxConfig.organizationPan']}</p>
                  )}
                </div>
                <div>
                  <label className="mb-1.5 block text-[13px] font-medium text-foreground">
                    80G Registration Number <span className="text-destructive">*</span>
                  </label>
                  <input
                    type="text"
                    value={draft.taxConfig.registrationNumber}
                    onChange={e => updateTax({ registrationNumber: e.target.value })}
                    placeholder="CIT/80G/2024/001"
                    className={cn(
                      'w-full rounded-xl border bg-background px-3.5 py-2.5 text-[14px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary',
                      errors['taxConfig.registrationNumber'] ? 'border-destructive' : 'border-border',
                    )}
                  />
                  {errors['taxConfig.registrationNumber'] && (
                    <p className="mt-1 text-[12px] text-destructive">{errors['taxConfig.registrationNumber']}</p>
                  )}
                </div>
                <div>
                  <label className="mb-1.5 block text-[13px] font-medium text-foreground">
                    Certificate Expiry <span className="text-destructive">*</span>
                  </label>
                  <input
                    type="date"
                    min={new Date().toISOString().split('T')[0]}
                    value={draft.taxConfig.certificateExpiry}
                    onChange={e => updateTax({ certificateExpiry: e.target.value })}
                    className={cn(
                      'w-full rounded-xl border bg-background px-3.5 py-2.5 text-[14px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary',
                      errors['taxConfig.certificateExpiry'] ? 'border-destructive' : 'border-border',
                    )}
                  />
                  {errors['taxConfig.certificateExpiry'] && (
                    <p className="mt-1 text-[12px] text-destructive">{errors['taxConfig.certificateExpiry']}</p>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 80G incomplete warning — shown proactively; does not block navigation */}
      {draft.taxConfig.enabled && Object.keys(validateLinkedCampaign(draft)).some(k => k.startsWith('taxConfig')) && (
        <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800 dark:border-amber-800/40 dark:bg-amber-950/20 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>Complete 80G compliance details before publishing (PAN, registration number, certificate).</span>
        </div>
      )}

      <WizardFooter
        onBack={onBack}
        onNext={handleNext}
        onSaveDraft={handleSave}
        nextLabel="Continue to Review"
        isNextDisabled={showErrors && !isLinkedCampaignNavigationValid(draft)}
        stepContext={stepContext}
      />
    </motion.div>
  )
}
