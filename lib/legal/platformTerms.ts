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
    heading: 'RegisterDesk Event Terms and Conditions',
    paragraphs: [
      'These Event Terms and Conditions govern your use of the RegisterDesk platform to discover, register for, and participate in events. By registering for an event through RegisterDesk, you acknowledge that you have read, understood, and agreed to these terms and any additional event-specific terms, conditions, waivers, or requirements provided by the event organizer.',
    ],
  },
  {
    heading: 'Participant Responsibilities',
    paragraphs: [
      'Participants are responsible for providing accurate, complete, and current information during registration and for ensuring that they meet any eligibility requirements specified by the event organizer.',
      'Participants must comply with all event rules, safety instructions, venue requirements, applicable laws, and reasonable directions issued by the event organizer, venue, event personnel, or relevant authorities.',
      'Participants are responsible for their own conduct, belongings, and personal safety while attending or participating in an event and should take reasonable precautions appropriate to the nature of the event.',
    ],
  },
  {
    heading: 'Event Organizer Responsibility',
    paragraphs: [
      'RegisterDesk provides technology and services that enable event organizers to create, manage, promote, and administer events and enable participants to register for those events. Unless expressly stated otherwise, RegisterDesk is not the organizer, promoter, producer, venue operator, or principal service provider of the event.',
      'The event organizer is solely responsible for the planning, organization, operation, management, safety arrangements, venue, event content, participant eligibility, event-specific rules, permits, approvals, and delivery of the event.',
      'Any representation, promise, service, facility, prize, benefit, schedule, route, venue arrangement, or other commitment relating specifically to an event is the responsibility of the relevant event organizer unless RegisterDesk expressly states otherwise.',
      'Participants should contact the event organizer for event-specific matters, including questions concerning schedules, venues, event facilities, eligibility, postponements, cancellations, refunds, or other arrangements relating to the event.',
    ],
  },
  {
    heading: 'Event Participation and Assumption of Risk',
    paragraphs: [
      'Participation in an event may involve inherent or foreseeable risks, including risks associated with physical activity, sports, travel, weather conditions, terrain, traffic, venues, equipment, other participants, or third parties.',
      'Participants are responsible for determining whether they are physically and otherwise suitable to participate in an event and should obtain appropriate medical or professional advice where necessary.',
      'Where an event requires a medical declaration, consent, waiver, undertaking, age requirement, identification document, or other condition of participation, the participant must comply with the requirements specified by the event organizer.',
      'RegisterDesk does not provide medical, safety, legal, or professional advice regarding an individual participant’s suitability for an event.',
    ],
  },
  {
    heading: 'Registration and Payment',
    paragraphs: [
      'Registration is completed only when the applicable payment has been successfully processed and the registration has been confirmed through RegisterDesk or by the relevant event organizer, as applicable.',
      'Payments may be processed through third-party payment service providers. RegisterDesk does not ordinarily store complete payment credentials such as card numbers, UPI PINs, or banking passwords. Payment information is handled by the applicable payment service provider in accordance with its terms, security practices, and applicable requirements.',
      'The registration amount, applicable taxes, platform charges, convenience fees, and other applicable charges will be displayed during the registration process before payment is submitted.',
      'A payment attempt that is declined, cancelled, abandoned, expired, timed out, or otherwise unsuccessful does not constitute a completed registration. If an amount is debited despite an unsuccessful payment, the applicable payment service provider or banking system may process the reversal or refund in accordance with its applicable timelines and procedures.',
    ],
  },
  {
    heading: 'Refunds, Cancellations, and Transfers',
    paragraphs: [
      'Refunds, cancellations, transfers, and postponements are subject to the refund and cancellation policy applicable to the relevant event, together with applicable law.',
      'The event organizer is responsible for determining and honoring the event-specific refund, cancellation, transfer, or postponement policy, unless RegisterDesk has expressly undertaken a different responsibility.',
      'Where RegisterDesk facilitates a refund on behalf of an event organizer, the processing and timing of the refund may depend on the payment service provider, banking system, and applicable refund procedures.',
      'Participants should carefully review the event-specific refund and cancellation policy before completing registration.',
    ],
  },
  {
    heading: 'Event Changes, Postponement, or Cancellation',
    paragraphs: [
      'The event organizer may change, postpone, reschedule, relocate, modify, or cancel an event where reasonably necessary, subject to applicable law and the terms applicable to that event.',
      'Where RegisterDesk receives information regarding a material event change and notification through the platform is applicable, RegisterDesk may communicate the relevant information to registered participants using the contact details available to it.',
      'RegisterDesk is not responsible for personal or consequential expenses incurred by participants in connection with an event, including travel, accommodation, transportation, meals, or other incidental expenses, except to the extent that such liability cannot lawfully be excluded or limited.',
    ],
  },
  {
    heading: 'Personal Information and Privacy',
    paragraphs: [
      'RegisterDesk may collect and process information provided by participants for purposes including creating and managing accounts, processing event registrations, facilitating payments, communicating event-related information, providing customer support, managing participation records, issuing certificates or other event-related documents, maintaining platform security, preventing fraud or misuse, and complying with applicable legal obligations.',
      'Information may be shared with the relevant event organizer, payment service providers, communication providers, technology service providers, or other service providers where reasonably necessary to provide RegisterDesk services, administer an event, process a transaction, communicate with participants, maintain security, or comply with applicable law.',
      'RegisterDesk does not sell personal information for monetary consideration. Personal information will be handled in accordance with the RegisterDesk Privacy Policy and applicable data-protection requirements.',
      'Participants should review the RegisterDesk Privacy Policy for further information about the information collected, purposes of processing, retention, participant rights, and available contact or grievance mechanisms.',
    ],
  },
  {
    heading: 'RegisterDesk Platform Responsibility',
    paragraphs: [
      'RegisterDesk will use reasonable efforts to maintain the availability, security, and functionality of its platform and services. However, uninterrupted or error-free availability cannot be guaranteed at all times due to maintenance, technical failures, internet connectivity, third-party services, payment systems, telecommunications networks, or circumstances beyond RegisterDesk’s reasonable control.',
      'RegisterDesk is not responsible for the independent acts, omissions, representations, negligence, misconduct, or failures of an event organizer, venue, payment service provider, communication provider, participant, or other third party, except to the extent responsibility is imposed on RegisterDesk under applicable law.',
      'Information relating to an event may be provided by the event organizer. Participants should verify important event-specific information and rely on the latest official communication made available by the organizer or through RegisterDesk.',
    ],
  },
  {
    heading: 'Limitation of Liability',
    paragraphs: [
      'To the maximum extent permitted by applicable law, RegisterDesk will not be liable for indirect, incidental, special, consequential, or purely economic losses arising from an event or from the acts or omissions of an event organizer or other third party.',
      'To the extent permitted by applicable law, RegisterDesk’s liability in connection with the platform or a particular registration will be limited to the amount actually paid by the participant to RegisterDesk for the relevant platform service giving rise to the claim, except where a different limitation is required by applicable law.',
      'Nothing in these terms excludes, restricts, or limits any liability, right, or remedy that cannot lawfully be excluded, restricted, or limited under applicable law.',
    ],
  },
  {
    heading: 'Third-Party Services',
    paragraphs: [
      'RegisterDesk may rely on third-party services, including payment gateways, email providers, messaging services, cloud infrastructure, authentication services, analytics services, and other technology providers.',
      'RegisterDesk is not responsible for interruptions, failures, delays, or actions of third-party services that are outside RegisterDesk’s reasonable control, subject always to any rights and remedies available to participants under applicable law.',
    ],
  },
  {
    heading: 'Prohibited Conduct',
    paragraphs: [
      'Participants must not provide false or misleading information, impersonate another person, misuse registration credentials, attempt unauthorized access, interfere with the platform, abuse payment or refund processes, or use RegisterDesk for unlawful, fraudulent, or abusive purposes.',
      'RegisterDesk may suspend or restrict access to an account, registration, or platform feature where reasonably necessary to protect the platform, its users, event organizers, payment systems, or third parties, or to comply with applicable law.',
    ],
  },
  {
    heading: 'Acceptance of Terms',
    paragraphs: [
      'By completing registration or using RegisterDesk to participate in an event, you confirm that you have read, understood, and agreed to these Platform Terms and Conditions and any applicable event-specific terms presented to you during the registration process.',
      'If you do not agree to these terms or the applicable event-specific terms, you should not complete the registration or participate in the relevant event.',
    ],
  },
  {
    heading: 'Changes to These Terms',
    paragraphs: [
      'RegisterDesk may update these Platform Terms from time to time to reflect changes to its services, legal requirements, security practices, or operational processes.',
      'Where required by applicable law, material changes will be communicated through appropriate means. The version of the terms applicable to a particular registration will be made available through the platform or otherwise communicated as appropriate.',
    ],
  },
  {
    heading: 'Contact',
    paragraphs: [
      'For questions or concerns relating to RegisterDesk platform services or these terms, please contact us at support@registerdesk.in.',
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
