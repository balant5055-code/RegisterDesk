// GET /api/admin/events/[slug]/preview — Super Admin only.
//
// The data behind the pre-approval preview (/admin/preview/events/[slug]): the EXACT props the
// public event page would render, for an event in ANY lifecycle state — including
// 'pending_review', which the public route 404s for everyone (that is why the approval
// queue's old "Preview" link, which pointed at /events/{slug}, never worked).
//
// ═══ SAME PAGE, NOT AN APPROXIMATION ═════════════════════════════════════════
// Props come from lib/events/eventPageProps — the one mapping the public page also uses —
// rendered for the state the event will have once approved ('published'). The preview page
// feeds them to the real TemplateRouter.
//
// ═══ THE REVIEW APPENDIX ═════════════════════════════════════════════════════
// Everything the public page does NOT show but a reviewer must check: EVERY ticket with every
// stored field (including hidden, inactive and complimentary ones), the fee collection model
// actually applied and the per-ticket attendee-payable / organizer-net ESTIMATE from the same
// fee engine the ledger uses, access and registration rules, SEO, the linked campaign's donation
// settings, and warnings from the EXISTING publish validation (warnings only — never a block).
// Each setting says whether server code enforces it or it is configured/displayed only.
//
// ═══ WHAT THIS RESPONSE NEVER CARRIES ════════════════════════════════════════
// The invite code, the approved-contact list (counts only), draft, licence, payment, payout,
// wallet or attendee data. Cache-Control: no-store; X-Robots-Tag: noindex.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { getEventBySlug } from '@/lib/firebase/firestore/events'
import { getCampaignBySlug } from '@/lib/firebase/firestore/campaigns'
import { loadEventPageData, buildEventPageProps } from '@/lib/events/eventPageProps'
import { validateEventPublish } from '@/lib/events/validatePublish'
import { resolveEventFeeConfig } from '@/lib/fees/resolveEventFeeConfig'
import { calculateFee } from '@/lib/fees/engine'
import { checkoutFeeModel } from '@/lib/fees/explicitFeeModel'
import { resolvePlatformPricing } from '@/lib/platform/pricing/resolver'
import { nowLocalInTz, resolvePassSaleState } from '@/lib/registrations/salesWindow'
import { approvedContactEmails } from '@/lib/registrations/approvedContactAccess'
import type { EventDetailProps } from '@/components/event-templates/types'

type Ctx = { params: Promise<{ slug: string }> }

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0', 'X-Robots-Tag': 'noindex, nofollow' }

export type Enforcement = 'enforced' | 'configured_only' | 'platform_disabled'

export interface AdminEventPreviewField {
  label:       string
  type:        string
  required:    boolean
  section:     string | null
  options:     string[]
  /** Shown only for some tickets (passVisibility ≠ 'all'). */
  perTicket:   boolean
  conditional: boolean
}

export interface AdminPreviewFees {
  attendeePaysPaise:       number
  platformFeePaise:        number   // incl. GST
  gatewayFeeEstimatePaise: number
  organizerNetPaise:       number
}

export interface AdminPreviewPass {
  name:              string
  description:       string
  code:              string | null
  type:              string        // paid | free | complimentary | invite_only
  isFree:            boolean
  pricePaise:        number
  currency:          string
  status:            string        // active | inactive
  visibility:        string        // public | private | invite_only
  publiclyListed:    boolean
  unlimited:         boolean
  quantity:          number | null
  minPurchase:       number | null
  maxPurchase:       number | null
  salesStartDate:    string | null
  salesEndDate:      string | null
  saleState:         string        // scheduled | open | ended
  earlyBird:         { enabled: boolean; pricePaise: number | null; endDate: string | null }
  hideWhenSoldOut:   boolean
  showRemainingSeats: boolean
  featured:          boolean
  benefits:          string[]
  raceDetails:       { category: string | null; minAge: number | null; maxAge: number | null; teamSize: number | null } | null
  flags:             { transferable: boolean; refundable: boolean; waitlist: boolean; groupBooking: boolean }
  /** Estimate at the regular price (and early-bird price when enabled); null for a free ticket. */
  fees:              AdminPreviewFees | null
  earlyBirdFees:     AdminPreviewFees | null
}

export interface AdminEventPreviewResponse {
  slug:            string
  /** The STORED lifecycle (e.g. pending_review); the props render as 'published'. */
  lifecycleStatus: string
  reviewStatus:    string | null
  props:           EventDetailProps
  review: {
    visibility:        string | null
    confirmationMode:  string | null
    access: {
      mode:                 string            // open | invite_code | approved_contacts
      inviteCodeConfigured: boolean
      approvedContactCount: number
      /** Contacts with a usable email — only these can pass the verified-email check. */
      approvedContactsWithEmail: number
    }
    registrationFields: AdminEventPreviewField[]
    registrationRules:  { label: string; value: string; enforcement: Enforcement }[]
    pricing: {
      model:                'free' | 'paid'
      currency:             string
      registrationOpenDate: string | null
      registrationEndDate:  string | null
      feeCollection: {
        applied:     string            // what checkout ACTUALLY does
        storedValue: string | null     // pricing.feeModel as stored (not used for charging)
        termsSource: 'event' | 'global' | null
        feesAvailable: boolean
      }
    }
    passes:      AdminPreviewPass[]
    seo:         { metaTitle: string | null; metaDescription: string | null; keywords: string[]; urlSlug: string | null }
    campaign:    {
      title: string; goalRupees: number | null; endDate: string | null; minimumRupees: number | null; maximumRupees: number | null
      beneficiaryName: string | null; beneficiaryType: string | null; taxDeduction80G: boolean; allowOverFunding: boolean
    } | null
    /** From the EXISTING publish validation, run against the stored event — warnings, never blocks. */
    warnings:    { id: string; title: string; message: string }[]
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

function registrationFields(form: unknown): AdminEventPreviewField[] {
  const f = rec(form)
  // `sections` is the primary store; `fields` is the flat backward-compat list.
  const fromSections = Array.isArray(f.sections)
    ? (f.sections as unknown[]).flatMap(s => {
        const sec = rec(s)
        const title = str(sec.title)
        return Array.isArray(sec.fields) ? (sec.fields as unknown[]).map(x => [x, title] as const) : []
      })
    : []
  const pairs = fromSections.length
    ? fromSections
    : (Array.isArray(f.fields) ? (f.fields as unknown[]).map(x => [x, null] as const) : [])
  return pairs
    .map(([x, section]) => ({ field: rec(x), section }))
    .filter(({ field }) => field.visible !== false && str(field.label))
    .map(({ field, section }) => ({
      label:       str(field.label)!,
      type:        str(field.type) ?? 'text',
      required:    field.required === true,
      section,
      options:     Array.isArray(field.options) ? (field.options as unknown[]).filter((o): o is string => typeof o === 'string').slice(0, 50) : [],
      perTicket:   Array.isArray(field.passVisibility),
      conditional: field.conditionalLogic != null,
    }))
}

const yes = (b: unknown) => (b === true ? 'Yes' : 'No')

/** Registration rules as stored, each marked by whether server code acts on it (verified by source). */
function registrationRules(form: unknown, confirmationMode: string | null): AdminEventPreviewResponse['review']['registrationRules'] {
  const r = rec(rec(form).registrationRules)
  return [
    { label: 'Confirmation',                  value: confirmationMode ?? 'auto',                 enforcement: 'enforced' },
    { label: 'Require sign-in',               value: yes(r.requireLogin),                       enforcement: 'enforced' },
    { label: 'One registration per email',    value: yes(r.limitPerEmail),                      enforcement: 'enforced' },
    { label: 'One registration per mobile',   value: yes(r.limitPerMobile),                     enforcement: 'enforced' },
    { label: 'Waitlist',                      value: yes(r.waitlistEnabled) + (num(r.waitlistCapacity) !== null ? ` (cap ${num(r.waitlistCapacity)})` : ''), enforcement: 'platform_disabled' },
    { label: 'Registration mode',             value: str(r.registrationMode) ?? 'individual',   enforcement: 'configured_only' },
    { label: 'Require email verification',    value: yes(r.requireEmailVerification),           enforcement: 'configured_only' },
    { label: 'Require mobile verification',   value: yes(r.requireMobileVerification),          enforcement: 'configured_only' },
    { label: 'Allow guest registration',      value: yes(r.allowGuestRegistration),             enforcement: 'configured_only' },
    { label: 'Duplicate policy',              value: str(r.duplicatePolicy) ?? '—',             enforcement: 'configured_only' },
  ]
}

export async function GET(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: NO_STORE })

  const { slug } = await params
  const event = await getEventBySlug(slug)
  if (!event) return NextResponse.json({ error: 'Event not found' }, { status: 404, headers: NO_STORE })

  const [data, feeTerms, campaignDoc] = await Promise.all([
    loadEventPageData(slug, event, { includeUnapprovedCampaign: true }),
    resolveEventFeeConfig(slug),
    event.linkedCampaignSlug ? getCampaignBySlug(event.linkedCampaignSlug) : Promise.resolve(null),
  ])
  const { props } = buildEventPageProps(slug, event, data, { displayLifecycle: 'published' })

  const raw     = event as unknown as Record<string, unknown>
  const pricing = rec(event.pricing)
  const ed      = rec(event.eventDetails)
  const ac      = rec(event.accessControl)
  const currency = str(pricing.currency) ?? 'INR'
  const tz       = str(rec(ed.schedule).timezone) ?? 'UTC'
  const nowLocal = nowLocalInTz(tz)

  // Per-ticket economics from the SAME engine the registration ledger uses (lib/payments/
  // registrationLedger → calculateFee), with this event's resolved terms and the fee model a new
  // checkout applies (`checkoutFeeModel` — create-order's rule: the organizer's recorded choice when
  // the pricing engine is on, else organizer pays). It was hard-coded to organizer pays, so an
  // attendee-pays event was approved against the wrong attendee total and net. An ESTIMATE: real
  // terms lock at checkout.
  const feeModel = checkoutFeeModel((await resolvePlatformPricing()).features.pricingEngineEnabled, event.pricing)
  const feesFor = (pricePaise: number): AdminPreviewFees | null => {
    if (!feeTerms.ok || pricePaise <= 0) return null
    const r = calculateFee({ transactionType: 'event_registration', grossAmountPaise: pricePaise, feeModel, config: feeTerms.config })
    return {
      attendeePaysPaise:       r.chargeAmountPaise,
      platformFeePaise:        r.platformFeeTotalPaise,
      gatewayFeeEstimatePaise: r.gatewayFeeEstimatePaise,
      organizerNetPaise:       r.netSettlementPaise,
    }
  }

  const passes: AdminPreviewPass[] = (Array.isArray(pricing.passes) ? pricing.passes as unknown[] : [])
    .map(rec)
    .filter(p => str(p.name))
    .map(p => {
      const price  = num(p.price) ?? 0
      const pricePaise = Math.round(price * 100)
      const adv    = rec(p.advancedSettings)
      const race   = p.raceDetails && typeof p.raceDetails === 'object' ? rec(p.raceDetails) : null
      const ebOn   = p.earlyBirdEnabled === true
      const ebPaise = ebOn && num(p.earlyBirdPrice) !== null ? Math.round(num(p.earlyBirdPrice)! * 100) : null
      const visibility = str(p.visibility) ?? 'public'
      return {
        name:               str(p.name)!,
        description:        str(p.description) ?? '',
        code:               str(p.code),
        type:               str(p.type) ?? (price > 0 ? 'paid' : 'free'),
        isFree:             price === 0,
        pricePaise,
        currency,
        status:             str(p.status) ?? 'active',
        visibility,
        publiclyListed:     visibility !== 'private' && visibility !== 'invite_only' && p.status !== 'inactive',
        unlimited:          p.unlimited === true,
        quantity:           p.unlimited === true ? null : num(p.quantity),
        minPurchase:        num(p.minPurchase),
        maxPurchase:        num(p.maxPurchase),
        salesStartDate:     str(p.salesStartDate),
        salesEndDate:       str(p.salesEndDate),
        saleState:          resolvePassSaleState({ salesStartDate: str(p.salesStartDate), salesEndDate: str(p.salesEndDate) }, nowLocal),
        earlyBird:          { enabled: ebOn, pricePaise: ebPaise, endDate: str(p.earlyBirdEndDate) },
        hideWhenSoldOut:    p.hideWhenSoldOut === true,
        showRemainingSeats: p.showRemainingSeats !== false,
        featured:           p.featured === true,
        benefits:           [...(Array.isArray(p.benefits) ? p.benefits : []), ...(Array.isArray(p.customBenefits) ? p.customBenefits : [])].filter((b): b is string => typeof b === 'string'),
        raceDetails:        race ? { category: str(race.customCategory) ?? str(race.category), minAge: num(race.minAge), maxAge: num(race.maxAge), teamSize: num(race.teamSize) } : null,
        flags:              { transferable: adv.transferable === true, refundable: adv.refundable === true, waitlist: adv.waitlist === true, groupBooking: adv.groupBooking === true },
        fees:               feesFor(pricePaise),
        earlyBirdFees:      ebPaise !== null ? feesFor(ebPaise) : null,
      }
    })

  // Warnings: the EXISTING publish validation, run on what approval would publish. Never a block.
  const validation = validateEventPublish({
    status:               undefined as unknown as string,
    pricing:              event.pricing,
    eventDetails:         event.eventDetails,
    communicationBilling: null,
    registrationForm:     event.registrationForm as unknown as Record<string, unknown> | null,
    eventType:            event.eventType,
    eventSubtype:         event.eventSubtype,
  })
  const warnings = validation.canPublish ? [] : (validation.blockers ?? [{ id: validation.reason, title: validation.reason, description: '' }])
    .map(b => ({ id: b.id, title: b.title, message: b.description }))
  for (const p of passes) {
    if (p.status !== 'inactive' && p.saleState === 'ended') {
      warnings.push({ id: `sales_ended:${p.name}`, title: 'Ticket Sales Already Ended', message: `${p.name}: its sales window closed ${p.salesEndDate ?? ''} — it cannot be bought once published.` })
    }
  }

  const seo = rec(ed.seo)
  const cd  = campaignDoc ? rec(campaignDoc.campaignDetails) : null
  const ds  = campaignDoc ? rec(campaignDoc.donationSettings) : null
  const approvedList = Array.isArray(ac.approvedContacts) ? ac.approvedContacts : []

  const body: AdminEventPreviewResponse = {
    slug,
    lifecycleStatus: event.lifecycleStatus,
    reviewStatus:    str(raw.reviewStatus),
    props,
    review: {
      visibility:       str(event.visibility),
      confirmationMode: str(ac.confirmationMode),
      access: {
        mode:                      str(ac.type) ?? 'open',
        inviteCodeConfigured:      !!str(rec(ac.inviteCode).code),
        approvedContactCount:      approvedList.length,
        approvedContactsWithEmail: approvedContactEmails(event.accessControl).size,
      },
      registrationFields: registrationFields(event.registrationForm),
      registrationRules:  registrationRules(event.registrationForm, str(ac.confirmationMode)),
      pricing: {
        model:                pricing.eventType === 'free' ? 'free' : 'paid',
        currency,
        registrationOpenDate: str(pricing.registrationOpenDate),
        registrationEndDate:  str(pricing.registrationEndDate),
        feeCollection: {
          applied:       feeModel === 'customer_pays'
            ? 'Attendee pays — platform fees are added to the ticket price at checkout; the organizer receives the ticket value'
            : 'Organizer pays — attendees are charged the ticket price only; platform and gateway fees are deducted from the organizer payout',
          storedValue:   str(pricing.feeModel),
          termsSource:   feeTerms.ok ? feeTerms.source : null,
          feesAvailable: feeTerms.ok,
        },
      },
      passes,
      seo: {
        metaTitle:       str(seo.metaTitle),
        metaDescription: str(seo.metaDescription),
        keywords:        Array.isArray(seo.keywords) ? (seo.keywords as unknown[]).filter((k): k is string => typeof k === 'string') : [],
        urlSlug:         str(seo.urlSlug),
      },
      campaign: cd ? {
        title:           str(rec(cd.basics).title) ?? '',
        goalRupees:      num(rec(cd.goal).targetAmountRupees),
        endDate:         str(rec(cd.goal).endDate),
        minimumRupees:   num(rec(ds?.amounts).minimumAmountRupees),
        maximumRupees:   num(rec(ds?.amounts).maximumAmountRupees),
        beneficiaryName: str(rec(cd.beneficiary).name),
        beneficiaryType: str(rec(cd.beneficiary).type),
        taxDeduction80G: rec(cd.taxConfig).enabled === true,
        allowOverFunding: rec(cd.goal).allowOverFunding === true,
      } : null,
      warnings,
    },
  }
  return NextResponse.json(body, { headers: NO_STORE })
}
