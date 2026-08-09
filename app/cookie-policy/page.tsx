// RD-LAUNCH-04 — /cookie-policy page. Server Component.
//
// Closes RD-LAUNCH-01 P1-1: the site published Privacy, Terms and Refund Policy but no
// Cookie Policy, leaving the legal set incomplete for a production SaaS platform.
//
// EVERY claim below was verified against the codebase before it was written. The
// findings that shaped it:
//
//   • Exactly ONE cookie is set by RegisterDesk: `attendee_session`
//     (lib/attendee/auth.ts:14,75) — httpOnly, secure in production, SameSite=Lax,
//     path '/', maxAge 30 days.
//   • Organizer sign-in does NOT use cookies. Firebase Auth persists tokens via
//     browserLocalPersistence / browserSessionPersistence (lib/firebase/auth/index.ts:29),
//     i.e. browser local storage, and the app sends them as Authorization headers.
//     Claiming "organizer authentication cookies" would have been false.
//   • There is NO analytics of any kind. Searches for gtag, googletagmanager,
//     google-analytics, hotjar, mixpanel, posthog, fbq, facebook.net and clarity all
//     return zero integrations. So this policy states plainly that we do not track.
//   • The only third-party browser script is Razorpay Checkout
//     (checkout.razorpay.com), loaded solely on the payment step.
//   • The registration form draft uses sessionStorage (not a cookie) — disclosed under
//     similar technologies because users reasonably think of them together.
//
// No cookie banner, no consent manager and no tracking behaviour was added: the platform
// sets only a strictly necessary cookie, which does not require consent.

import type { Metadata } from 'next'
import { LegalPage } from '@/components/marketing/legal/LegalPage'
import { OWNERSHIP_SENTENCE } from '@/lib/marketing/ownership'
import { buildMetadata, organizationJsonLd, breadcrumbJsonLd } from '@/lib/marketing/seo'

export const metadata: Metadata = buildMetadata({
  title:       'Cookie Policy | RegisterDesk',
  description: 'How RegisterDesk uses cookies and similar technologies — strictly necessary session cookies only, with no advertising or analytics tracking.',
  path:        '/cookie-policy',
})

export default function CookiePolicyPage() {
  const jsonLd = [
    organizationJsonLd(),
    breadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: 'Cookie Policy', path: '/cookie-policy' }]),
  ]

  return (
    <>
      <LegalPage
        title="Cookie Policy"
        intro={`${OWNERSHIP_SENTENCE} This policy explains the cookies and similar technologies RegisterDesk uses, why we use them, and how you can control them. We use only what is needed to sign you in and keep the platform secure — we do not use cookies for advertising or analytics.`}
        sections={[
          { heading: 'What cookies are', body: [
            'A cookie is a small text file that a website asks your browser to store. On each later request the browser sends it back, which is how a site can recognise that a series of requests came from the same person — for example, to keep you signed in as you move between pages.',
            'Some technologies behave similarly without being cookies. Browser local storage and session storage also keep small amounts of data in your browser. Where RegisterDesk uses those instead of cookies, they are described below, because the practical effect for you is the same.',
          ] },

          { heading: 'The cookies we set', body: [
            'RegisterDesk sets one cookie: an attendee session cookie named “attendee_session”. It is created when you sign in to the attendee area to view your registrations, tickets and certificates. It contains a signed reference to your session — not your name, email address or any registration details.',
            'It is a strictly necessary cookie. Without it, the attendee area cannot tell one signed-in person from another, so signing in would not be possible.',
            'It is set with httpOnly, so page scripts cannot read it; with the Secure attribute in production, so it is only ever sent over HTTPS; and with SameSite=Lax, which stops it from being sent along with most requests initiated by other websites.',
          ] },

          { heading: 'How long it lasts', body: [
            'The attendee session cookie expires 30 days after you sign in. Signing out deletes it immediately, and the matching session record on our side is invalidated at the same time, so an expired or signed-out session cannot be reused.',
            'You can also delete it at any time through your browser, as described under “Controlling cookies in your browser” below.',
          ] },

          { heading: 'Signing in as an organizer', body: [
            'Organizer sign-in does not use cookies. When you sign in to an organizer account, the authentication token is held in your browser’s local storage and sent to our servers with each request. If you choose not to stay signed in, it is held only for the current browser session and is discarded when you close the tab.',
            'Clearing your browser’s site data for RegisterDesk signs you out of an organizer account, in the same way that deleting a cookie would.',
          ] },

          { heading: 'Keeping your registration form safe', body: [
            'While you are filling in a registration form, your answers are saved in your browser’s session storage so a refresh or an interrupted payment does not lose your progress. This is not a cookie and is never sent to our servers on its own.',
            'It stays on your device, is cleared when you complete your registration, and is discarded by the browser when you close the tab. You can also discard it yourself using the “Start Over” option shown when a saved registration is found.',
          ] },

          { heading: 'Security', body: [
            'The session cookie described above is itself one of our security measures: signing the session reference, restricting it to HTTPS, hiding it from page scripts and limiting cross-site sending all reduce the risk of session theft or misuse.',
            'We do not set separate tracking or fingerprinting cookies for security purposes.',
          ] },

          { heading: 'Analytics and advertising', body: [
            'RegisterDesk does not use analytics cookies, advertising cookies or third-party tracking of any kind. There is no Google Analytics, no tag manager, no advertising pixel and no session-recording tool integrated into this website.',
            'We do not build advertising profiles, and we do not sell or share personal data with advertising networks.',
          ] },

          { heading: 'Preference cookies', body: [
            'We do not currently set cookies to remember display preferences such as language or theme. If that changes, this policy will be updated before any such cookie is introduced.',
          ] },

          { heading: 'Third-party cookies', body: [
            'When you pay for a registration, the payment step is handled by our payment provider, Razorpay, whose secure checkout is loaded into the page. Razorpay may set its own cookies to operate that checkout and to protect against fraud. Those cookies are controlled by Razorpay under its own privacy and cookie policies, not by RegisterDesk, and we never receive your card details.',
            'This is the only third-party component loaded into the RegisterDesk website, and it appears only on the payment step.',
          ] },

          { heading: 'Controlling cookies in your browser', body: [
            'Every major browser lets you view, block and delete cookies, usually under Settings → Privacy, and offers a private or incognito mode that discards them when you close the window.',
            'Because the only cookie we set is strictly necessary, blocking or deleting it will not reduce tracking — there is none — but it will sign you out of the attendee area and prevent you from signing back in until cookies are allowed again for this site.',
          ] },

          { heading: 'Consent', body: [
            'We do not show a cookie consent banner. Under privacy rules such as the GDPR and the UK PECR, consent is required for cookies that are not strictly necessary — analytics, advertising and similar. RegisterDesk sets no such cookies, so there is nothing to ask consent for.',
            'If we ever introduce a non-essential cookie, we will ask for your consent first and update this policy.',
          ] },

          { heading: 'Changes and contact', body: [
            'If our use of cookies changes, we will update this page. The version published here always applies.',
            'If you have questions about this policy or how we handle your data, contact us at support@registerdesk.in, or read our Privacy Policy for the full picture of how personal data is handled.',
          ] },
        ]}
      />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
    </>
  )
}
