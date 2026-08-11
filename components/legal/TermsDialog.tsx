'use client'

// Platform Terms & Conditions modal.
//
// Built on the existing <Dialog> primitive — focus trap, Escape, backdrop and the labelled
// dialog semantics all come from it, so there is no second modal system here.
//
// The text is rendered from lib/legal/platformTerms.ts VERBATIM. Nothing is summarised or
// paraphrased in this component; it only supplies typography and a scroll container.

import { useState } from 'react'
import { Dialog } from '@/components/ui/Dialog'
import { PLATFORM_TERMS_SECTIONS, PLATFORM_TERMS_TITLE } from '@/lib/legal/platformTerms'

export function TermsDialog({ open, onClose, onAgree, alreadyAgreed = false }: {
  open:           boolean
  onClose:        () => void
  /** Called when the attendee confirms inside the modal. */
  onAgree:        () => void
  /** Pre-checks the box when consent was already given, so reopening reads correctly. */
  alreadyAgreed?: boolean
}) {
  const [checked, setChecked] = useState(alreadyAgreed)

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={PLATFORM_TERMS_TITLE}
      size="lg"
      footer={
        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => { if (checked) { onAgree(); onClose() } }}
            disabled={!checked}
            className="inline-flex min-h-10 items-center justify-center rounded-xl bg-primary px-5 text-fs-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            I Agree
          </button>
        </div>
      }
    >
      {/* The SCROLLER is this container, so long terms scroll inside the modal and the
          page behind it never does. max-h keeps the footer action reachable on a phone. */}
      <div className="max-h-[45vh] overflow-y-auto pr-1 sm:max-h-[50vh]">
        {PLATFORM_TERMS_SECTIONS.map((section, i) => (
          <section key={i} className="mt-4 first:mt-0">
            {section.heading && (
              <h3 className="mb-1 text-fs-sm font-bold text-foreground">{section.heading}</h3>
            )}
            {section.paragraphs.map((p, j) => (
              <p key={j} className="mt-2 text-fs-sm leading-relaxed text-muted-foreground first:mt-0">
                {p}
              </p>
            ))}
          </section>
        ))}
      </div>

      <label className="mt-5 flex cursor-pointer items-start gap-2.5 rounded-xl border border-border bg-muted/25 p-3">
        <input
          type="checkbox"
          checked={checked}
          onChange={e => setChecked(e.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
        />
        <span className="text-fs-sm font-medium text-foreground">
          I have read and agree to the Terms &amp; Conditions
        </span>
      </label>
    </Dialog>
  )
}
