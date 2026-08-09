// FAQ data model — the legacy {question,answer}[] adapter.
//
// RD-ST4.3 (ST41-I01): lifted verbatim out of FAQShowcase.tsx so SERVER components can
// call it (a function exported from a 'use client' module becomes a client reference and
// throws when invoked on the server). Pure — no JSX, no hooks.

import type { FaqItem } from '@/components/wizard/eventDetailsConfig'

export function legacyFaqToItems(faqs: { question: string; answer: string }[] | undefined): FaqItem[] {
  return (faqs ?? [])
    .filter(f => f?.question?.trim() && f?.answer?.trim())
    .map((f, i) => ({ id: `faq_${i}`, question: f.question.trim(), answer: f.answer.trim(), enabled: true }))
}
