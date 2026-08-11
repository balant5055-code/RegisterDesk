// Platform Terms & Conditions — ONE source, read by the attendee modal AND by the server
// guards that enforce consent. Keeping the text and the version together here is what lets
// a stored `termsVersion` on a registration mean something later.
//
// Isomorphic and dependency-free so the registration routes can import it without pulling
// in any client code.

/**
 * Bumped whenever the text below changes. Stored on each registration so an acceptance can
 * be tied to the exact wording that was shown. Deliberately a plain date string rather than
 * a hash — it stays readable in the Firestore console and in an export.
 */
export const PLATFORM_TERMS_VERSION = '2026-08-11'

export const PLATFORM_TERMS_TITLE = 'Terms & Conditions'

/**
 * Platform support address shown in the terms. Mirrors the Config Engine default
 * (businessConfig integrations.supportEmail) — restated here rather than imported so this
 * module stays isomorphic and dependency-free for the server guards.
 */
export const PLATFORM_TERMS_SUPPORT_EMAIL = 'support@registerdesk.in'

/**
 * The agreement text, VERBATIM. Structured as headed sections purely so the modal can
 * render readable typography — no wording is added, removed or reinterpreted, and the
 * full text is present.
 */
export interface TermsSection {
  /** Undefined for the opening and closing paragraphs, which carry no heading. */
  heading?:    string
  paragraphs:  string[]
}

export const PLATFORM_TERMS_SECTIONS: readonly TermsSection[] = [
  {
    heading: 'RegisterDesk Event Terms and Conditions:',
    paragraphs: [
      'Welcome to RegisterDesk! Before participating in any of our events, please read and agree to the following terms and conditions:',
    ],
  },
  {
    heading: 'Participant Responsibilities:',
    paragraphs: [
      'By registering for an event on RegisterDesk, participants acknowledge and accept that they are solely responsible for their own safety, health, and actions during the event.',
      'Participants must comply with the rules, regulations, and guidelines set by the event organizer.',
    ],
  },
  {
    heading: 'Personal Information:',
    paragraphs: [
      'RegisterDesk collects personal information for the sole purpose of event registration and communication.',
      "Participants' personal information will not be shared, sold, or used for any other purposes without explicit consent.",
    ],
  },
  {
    heading: 'Liability Waiver:',
    paragraphs: [
      'Participants understand and agree that RegisterDesk is not liable for any injuries, damages, losses, or expenses that may occur during the event.',
      'Participants waive any claims against RegisterDesk and its affiliates in connection with their participation in the event.',
    ],
  },
  {
    heading: 'Registration and Payment:',
    paragraphs: [
      "Event registration is complete only upon receipt of payment, and refunds are subject to the event organizer's policies.",
      'RegisterDesk does not store or handle payment information directly. All transactions are securely processed through third-party payment gateways.',
    ],
  },
  {
    heading: 'Organizer Responsibility:',
    paragraphs: [
      'RegisterDesk acts solely as a platform to facilitate event registration and promotion. We do not assume responsibility for the organization, conduct, or safety of any events listed on our platform.',
      'Event organizers are solely responsible for the planning, execution, and safety measures of their respective events.',
    ],
  },
  {
    heading: 'Event Changes or Cancellation:',
    paragraphs: [
      'RegisterDesk reserves the right to modify event details, including dates, times, and locations, at its discretion.',
      'In the event of cancellation, RegisterDesk is not responsible for any costs incurred by participants, such as travel or accommodation expenses.',
    ],
  },
  {
    paragraphs: [
      'By registering for a RegisterDesk event, participants confirm that they have read, understood, and agreed to these terms and conditions. RegisterDesk reserves the right to update or modify these terms as needed. Participants are encouraged to review the terms regularly for any changes.',
      'If you have any questions or concerns, please contact us at support@registerdesk.in.',
      'Thank you for being part of the RegisterDesk community!',
    ],
  },
]

/** The consent payload every registration entry point must carry. */
export interface TermsConsentInput {
  termsAccepted?: unknown
  termsVersion?:  unknown
}

export interface TermsConsentResult {
  ok:       boolean
  error?:   string
  version?: string
}

/**
 * THE server-side gate. Strict by design: only a real boolean `true` passes, so a
 * truthy string, 1, or an object cannot smuggle consent past the check. Callers must run
 * this BEFORE creating a Razorpay order or a registration.
 */
export function validateTermsConsent(input: TermsConsentInput): TermsConsentResult {
  if (input.termsAccepted !== true) {
    return { ok: false, error: 'Please read and agree to the Terms & Conditions to continue.' }
  }
  // A missing/!string version is tolerated and stamped with the current one: the acceptance
  // itself is the legally meaningful act, and rejecting a valid consent over a metadata
  // field would block a real attendee for no benefit.
  const version = typeof input.termsVersion === 'string' && input.termsVersion.trim()
    ? input.termsVersion.trim()
    : PLATFORM_TERMS_VERSION
  return { ok: true, version }
}
