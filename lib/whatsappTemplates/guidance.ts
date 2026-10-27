// RD-WA-TEMPLATES-01 — plain-language help for a Meta rejection, and a suggested revision. PURE.
//
// The rule: Meta's own words come first and are shown exactly as received (reason code,
// rejection_info.reason / recommendation). This file only EXPLAINS a reason Meta actually gave. When
// Meta gave none (reason NONE / absent), the guidance says so and offers general advice — it never
// invents a cause. A suggested revision is a starting point; it is never presented as a guarantee.

import type { TemplateContent, TemplateCategory, VersionView } from './types'

export interface RejectionGuidance {
  /** Meta's reason code as received, or null when Meta gave none. */
  metaReason:     string | null
  title:          string
  explanation:    string
  steps:          string[]
  /** Meta's own detail, verbatim (INVALID_FORMAT rejections). */
  metaDetail:     { reason: string | null; recommendation: string | null } | null
  reasonProvided: boolean
}

const KNOWN: Record<string, { title: string; explanation: string; steps: string[] }> = {
  INCORRECT_CATEGORY: {
    title: 'The category did not match the content',
    explanation: 'Meta decided the message does not fit the category chosen — usually a Utility template that promotes something, or a Marketing template that is really a transactional update.',
    steps: [
      'If the message announces an offer, discount or another event, choose Marketing.',
      'If it is information about the attendee’s existing registration, keep Utility and remove any promotional sentences.',
      'Keep one purpose per template.',
    ],
  },
  PROMOTIONAL: {
    title: 'Meta considered the content promotional',
    explanation: 'Promotional wording (offers, discounts, “book now”) is not allowed in a Utility template.',
    steps: ['Remove the promotional wording, or create it as a Marketing template.', 'Keep Utility messages to facts about the attendee’s registration or the event.'],
  },
  INVALID_FORMAT: {
    title: 'The template’s format was not accepted',
    explanation: 'Something in the structure was not accepted — commonly a variable at the very start or end of the body, variables next to each other, too many variables for the amount of text, or unusual characters.',
    steps: [
      'Make sure the body starts and ends with fixed words, not a variable.',
      'Put words between variables.',
      'Check every variable has a realistic example value.',
      'Follow Meta’s own recommendation, if one is shown above.',
    ],
  },
  TAG_CONTENT_MISMATCH: {
    title: 'The content did not match the category or language',
    explanation: 'Meta found that the content does not match what the template declares — for example the wrong language selected, or a category that does not describe the message.',
    steps: ['Check the language selected matches the language the message is written in.', 'Check the category describes the message.'],
  },
  ABUSIVE_CONTENT: {
    title: 'Meta found content that breaks its policies',
    explanation: 'Meta’s review flagged the wording as violating WhatsApp’s Business or Commerce policies.',
    steps: ['Remove anything threatening, misleading, or about restricted goods or services.', 'Keep the message factual and about the attendee’s registration.', 'If you believe this is a mistake, contact the RegisterDesk team, who can appeal it with Meta.'],
  },
  SCAM: {
    title: 'Meta considered the content potentially misleading',
    explanation: 'Meta’s review flagged the message as possibly deceptive — for example unclear links, requests for payment or personal details, or urgent pressure.',
    steps: ['Use full links to your own website (no link shorteners).', 'Do not ask for passwords, card numbers or payments in the message.', 'Say clearly who is sending the message and why.'],
  },
  CATEGORY_NOT_AVAILABLE: {
    title: 'The category is not available',
    explanation: 'Meta does not offer this category for this account or region.',
    steps: ['Choose Utility or Marketing.'],
  },
}

const GENERAL_STEPS = [
  'Make sure the message clearly relates to the attendee’s registration or the event.',
  'Start and end the body with fixed words, and put words between variables.',
  'Give every variable a realistic example value.',
  'Keep promotional wording out of Utility templates.',
]

export function rejectionGuidance(meta: Pick<VersionView['meta'], 'rejectionReason' | 'rejectionDetail'>): RejectionGuidance {
  const reason = meta.rejectionReason
  const known = reason ? KNOWN[reason] : undefined
  if (known) return { metaReason: reason, ...known, metaDetail: meta.rejectionDetail, reasonProvided: true }
  if (reason) {
    return {
      metaReason: reason, title: `Meta gave the reason “${reason}”`,
      explanation: 'RegisterDesk does not have specific guidance for this reason code. The general checks below cover the most common causes.',
      steps: GENERAL_STEPS, metaDetail: meta.rejectionDetail, reasonProvided: true,
    }
  }
  return {
    metaReason: null, title: 'Meta did not give a specific reason',
    explanation: 'Meta rejected the template without stating why. The checks below cover the most common causes; they are general advice, not Meta’s explanation.',
    steps: GENERAL_STEPS, metaDetail: meta.rejectionDetail, reasonProvided: false,
  }
}

const PROMO_SENTENCE = /\b(discount|offer|sale|% ?off|coupon|promo|cashback|buy now|limited[- ]time|deal|free gift|hurry|book now|early[- ]bird|special price)\b/i

/**
 * A suggested starting point for the next version. Mechanical, explainable edits only — each one is
 * listed in `changes` so the organizer can see exactly what was altered. Never claims approval.
 */
export function suggestRevision(content: TemplateContent, category: TemplateCategory, reason: string | null): { content: TemplateContent; category: TemplateCategory; changes: string[] } {
  const changes: string[] = []
  let body = content.body.trim()
  let nextCategory = category

  if ((reason === 'INCORRECT_CATEGORY' || reason === 'PROMOTIONAL') && category === 'utility') {
    const sentences = body.split(/(?<=[.!?])\s+/)
    const kept = sentences.filter(s => !PROMO_SENTENCE.test(s))
    if (kept.length && kept.length < sentences.length) { body = kept.join(' '); changes.push('Removed the sentences with promotional wording, so the message stays a Utility update.') }
    else if (PROMO_SENTENCE.test(body)) { nextCategory = 'marketing'; changes.push('Changed the category to Marketing, because the message is promotional throughout.') }
  }
  if (!reason || reason === 'INVALID_FORMAT' || reason === 'TAG_CONTENT_MISMATCH') {
    if (/^\{\{[^}]+\}\}/.test(body)) { body = `Hi, ${body}`; changes.push('Added fixed words before the first variable.') }
    if (/\{\{[^}]+\}\}[\s.!?]*$/.test(body)) { body = `${body.replace(/[\s]*$/, '').replace(/([^.!?])$/, '$1.')} Thank you.`; changes.push('Added a closing sentence after the last variable.') }
    const spaced = body.replace(/\}\}(\s*)\{\{/g, '}} and {{')
    if (spaced !== body) { body = spaced; changes.push('Put a word between variables that were next to each other.') }
    if (!/\{\{eventName\}\}/.test(body)) { body = `${body} This message is about your registration for {{eventName}}.`; changes.push('Added a sentence saying which event the message is about.') }
  }
  body = body.replace(/(bit\.ly|tinyurl\.com|goo\.gl|cutt\.ly|rb\.gy)\/\S+/gi, m => { changes.push(`Flagged the shortened link "${m}" — replace it with the full link.`); return m })
  return { content: { ...content, body }, category: nextCategory, changes }
}
