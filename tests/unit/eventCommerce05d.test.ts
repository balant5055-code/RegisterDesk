// RD-EVENT-COMMERCE-05D — a live event's status on License & Services (not Review), and reliable
// Save Changes feedback. Server side (save never republishes; refused save keeps values):
// tests/emulator/publishedPricingSafety.emu.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const read  = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
const PAGE  = read('app/(dashboard)/dashboard/events/new/page.tsx')
const STEP7 = PAGE.slice(PAGE.indexOf('function Step7View('), PAGE.indexOf('// --- Campaign Publish Success'))
/** Executable code only — explanatory comments may name what moved away. */
const STEP7_CODE = STEP7.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
const LSS   = read('components/wizard/LicenseServicesStep.tsx')
const FOOT  = read('components/wizard/WizardFooter.tsx')
const TOAST = read('components/ui/Toast.tsx')

describe('the live-status banner moved from Review to License & Services', () => {
  it('Review renders no live / pending status, no View Live, no purchase action', () => {
    for (const s of ['Event is Live', 'View Live', 'Buy capacity or services', 'Submitted — awaiting approval']) {
      expect(STEP7_CODE, s).not.toContain(s)
    }
    expect(STEP7).toContain("{phase === 'review' || isSubmitted ? null : report.canPublish ? (")
  })
  it('License & Services renders exactly ONE status banner, for submitted events only, near the top', () => {
    expect((LSS.match(/'Event is Live'/g) ?? []).length).toBe(1)
    expect(LSS).toContain('{isSubmitted && liveStatus && (')
    // placed right after the header, before the capacity section
    expect(LSS.indexOf("'Event is Live'")).toBeLessThan(LSS.indexOf('aria-labelledby="license-capacity-heading"'))
    expect(LSS).toMatch(/role="status" className=\{cn\('mt-4 flex flex-wrap/)
  })
  it('View Live uses the canonical public URL; Buy stays on this step and focuses the purchase controls', () => {
    expect(LSS).toContain('<Link href={liveStatus.publicHref} target="_blank" rel="noopener noreferrer"')
    expect(LSS).toContain("document.getElementById('license-capacity-heading')?.scrollIntoView")
    expect(LSS).toContain("document.getElementById('capacity-input')?.focus")
    expect(LSS).toContain('doesn’t create a new event or republish it')
    expect(PAGE).toContain('const livePublicHref = typeof liveSlug === \'string\' && liveSlug ? buildEventHref(liveSlug) : null')
    expect(PAGE).toContain('liveStatus={{ publicHref: livePublicHref }}')
  })
  it('new / draft events never get the banner (only the submitted branch passes liveStatus)', () => {
    expect((PAGE.match(/liveStatus=\{\{/g) ?? []).length).toBe(1)
    // The NEW-event final view (the branch after the submitted one) never passes it.
    const lic = PAGE.slice(PAGE.indexOf('{currentStep === licenseStepIndex && (isSubmittedDraftStatus(draftStatus) ? ('))
    const draftBranch = lic.slice(lic.indexOf(') : ('), lic.indexOf('embeddedFinal={{ onContext }}'))
    expect(draftBranch).not.toContain('liveStatus')
    expect(lic.slice(0, lic.indexOf(') : ('))).toContain('liveStatus={{ publicHref: livePublicHref }}')
  })
  it('tap targets are ≥ 44px and the row wraps on narrow screens', () => {
    expect((LSS.match(/inline-flex min-h-11 items-center/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(LSS).toContain('flex w-full flex-wrap gap-2 sm:w-auto')
  })
})

describe('a live event’s Review: Save Changes stays; License & Services is one click away', () => {
  it('primary Save Changes (Saving… while pending), secondary → License & Services', () => {
    expect(STEP7).toContain("nextLabel={isAlreadyPublished ? (saveChangesState === 'saving' ? 'Saving…' : 'Save Changes') : 'Continue'}")
    expect(STEP7).toContain("secondaryAction={isAlreadyPublished ? { label: 'License & Services', onClick: () => onNext(), disabled: saveChangesState === 'saving' } : undefined}")
    expect(FOOT).toContain('secondaryAction?: { label: string; onClick: () => void; disabled?: boolean;')
  })
})

describe('Save Changes feedback', () => {
  const save = STEP7.slice(STEP7.indexOf('const handleSaveChanges'), STEP7.indexOf('const scoreGrade'))
  it('success toast ONLY after the server confirmed (success === true), then the baseline re-aligns', () => {
    const ok = save.indexOf("showToast('Changes saved successfully', 'success')")
    expect(ok).toBeGreaterThan(save.indexOf('if (!res.ok || json.success !== true) {'))
    expect(save.indexOf('onServerSaved?.()')).toBeLessThan(ok)
    expect(PAGE).toContain('onServerSaved={markPublished}')
  })
  it('failure: an error toast, no success toast, values untouched', () => {
    expect(save).toContain("'Your changes couldn’t be saved. Nothing was changed — please try again.'")
    expect(save).toContain('We couldn’t reach the server, so your changes were not saved.')
    expect(save).not.toMatch(/setDraft|reset|clear/i)
  })
  it('no duplicate saves: a ref guard, released in finally', () => {
    expect(save).toContain('if (saveChangesState !== \'idle\' || saveInFlight.current) return')
    expect(save).toMatch(/finally \{\s*saveInFlight\.current = false\s*setSaveChangesState\('idle'\)/)
  })
  it('toasts rise above the fixed wizard footer instead of covering its buttons', () => {
    expect(FOOT).toContain("root.style.setProperty('--wizard-footer-h'")
    expect(FOOT).toContain("root.style.removeProperty('--wizard-footer-h')")
    expect(TOAST).toContain('bottom-[calc(var(--wizard-footer-h,0px)+1rem)]')
    expect(TOAST).toContain('role="alert" aria-live="assertive"')
    expect(TOAST).toContain('aria-live="polite"')
  })
})
