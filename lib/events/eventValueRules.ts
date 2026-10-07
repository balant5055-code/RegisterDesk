import { formTemplateIncompatible } from '@/lib/events/builder/typeTransition'
// RD-CE-FIX H1 · authoritative VALUE rules for an event. PURE + isomorphic (Intl only).
//
// The publish gate (publishRequirements) only proved that fields were FILLED. Because drafts are
// written by the browser, the audit published — verbatim, onto the live event — an event ending
// before it started, a ₹-500 pass with quantity -5, min purchase 5 > max 0, and a sales window that
// closed before it opened. These rules are the server's own check of the VALUES, run by:
//   • validateEventPublish (publish, republish, resubmit)  — mode 'publish'
//   • Save Changes and PATCH /edit                          — mode 'update'
// 'publish' additionally refuses an event that has already ended. 'update' never does: a live event
// can be running or over, and editing its description must keep working.
//
// Dates are the wizard's own naive strings ('YYYY-MM-DD', 'HH:mm', datetime-local
// 'YYYY-MM-DDTHH:mm'), interpreted in ONE consistent frame, so ordering checks are exact.

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? v as Rec : {})
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export interface EventValueIssue {
  id:        string   // stable, e.g. 'schedule_order' / 'pass_price:pass_0'
  title:     string
  message:   string
  stepName:  'Event Details' | 'Passes & Pricing' | 'Registration Form'
  stepIndex: number
}

export interface EventValueInput {
  eventDetails:     unknown
  pricing:          unknown
  registrationForm?: unknown
  eventType?:       unknown
  eventSubtype?:    unknown
}

const DATE_RE  = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE  = /^([01]\d|2[0-3]):[0-5]\d$/
const LOCAL_RE = /^\d{4}-\d{2}-\d{2}(T([01]\d|2[0-3]):[0-5]\d)?$/

const validDate = (d: string) => DATE_RE.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d
/** A naive local date(+time) as a sortable minute count (same frame for every value). */
const minutes = (date: string, time: string, endOfDay = false): number => {
  const t = TIME_RE.test(time) ? time : (endOfDay ? '23:59' : '00:00')
  return Date.parse(`${date}T${t}:00Z`) / 60_000
}
const localMinutes = (v: string, endOfDay = false): number | null => {
  if (!LOCAL_RE.test(v)) return null
  const [d, t = ''] = v.split('T')
  return validDate(d) ? minutes(d, t, endOfDay) : null
}
const todayIn = (tz: string): string => {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()) }
  catch { return new Date().toISOString().slice(0, 10) }
}
const MAX_PRICE_RUPEES = 10_000_000
const MAX_QUANTITY     = 1_000_000
const twoDecimals = (n: number) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6

/**
 * The publish-time value issues — ONE function for the server gate (validateEventPublish) and the
 * wizard's Review step, so the organizer sees every value blocker BEFORE paying, and the server can
 * never refuse something the Review page passed. Adds the type check: a registration form built for
 * a different event type (RD-CE-FIX H3).
 */
export function publishValueIssues(input: EventValueInput): EventValueIssue[] {
  const issues = validateEventValues(input, 'publish')
  const type = typeof input.eventType === 'string' ? input.eventType : null
  const sub  = typeof input.eventSubtype === 'string' ? input.eventSubtype : null
  if (formTemplateIncompatible(type, sub, input.registrationForm)) {
    issues.push({
      id: 'form_template_type', title: 'Registration Form Is For Another Event Type',
      message: 'This registration form was built for a different kind of event. Choose a form for this event type.',
      stepName: 'Registration Form', stepIndex: 4,
    })
  }
  return issues
}

/**
 * For EDITS of a live event: only the issues the change INTRODUCES. A legacy event that already
 * carries an inconsistency can still have unrelated fields edited; no edit can make it invalid.
 */
export function introducedValueIssues(before: EventValueInput, after: EventValueInput): EventValueIssue[] {
  const had = new Set(validateEventValues(before, 'update').map(i => i.id))
  return validateEventValues(after, 'update').filter(i => !had.has(i.id))
}

/** Pure. A copy of `doc` with Firestore-style dotted field-path `updates` applied (for previews). */
export function applyFieldPaths(doc: Rec, updates: Rec): Rec {
  const out: Rec = JSON.parse(JSON.stringify(doc ?? {}))
  for (const [path, value] of Object.entries(updates)) {
    const keys = path.split('.')
    let node = out
    for (const k of keys.slice(0, -1)) {
      if (!node[k] || typeof node[k] !== 'object' || Array.isArray(node[k])) node[k] = {}
      node = node[k] as Rec
    }
    node[keys[keys.length - 1]] = value
  }
  return out
}

export function validateEventValues(input: EventValueInput, mode: 'publish' | 'update'): EventValueIssue[] {
  const issues: EventValueIssue[] = []
  const details  = rec(input.eventDetails)
  const info     = rec(details.info)
  const schedule = rec(details.schedule)
  const venue    = rec(details.venue)
  const online   = rec(venue.online)
  const pricing  = rec(input.pricing)
  const ED = { stepName: 'Event Details' as const, stepIndex: 5 }
  const PP = { stepName: 'Passes & Pricing' as const, stepIndex: 3 }

  // ── Text bounds ────────────────────────────────────────────────────────────────
  if (str(info.name).length > 200)     issues.push({ id: 'name_length', title: 'Event Name Too Long', message: 'Keep the event name under 200 characters.', ...ED })
  if (str(info.shortDesc).length > 300) issues.push({ id: 'short_desc_length', title: 'Short Description Too Long', message: 'Keep the short description under 300 characters.', ...ED })
  if (str(info.fullDesc).length > 20_000) issues.push({ id: 'full_desc_length', title: 'Description Too Long', message: 'Keep the full description under 20,000 characters.', ...ED })

  // ── Schedule ───────────────────────────────────────────────────────────────────
  const startDate = str(schedule.startDate), endDate = str(schedule.endDate)
  const startTime = str(schedule.startTime), endTime = str(schedule.endTime)
  if (startDate && !validDate(startDate)) issues.push({ id: 'start_date', title: 'Invalid Start Date', message: 'Enter a real start date.', ...ED })
  if (endDate && !validDate(endDate))     issues.push({ id: 'end_date', title: 'Invalid End Date', message: 'Enter a real end date.', ...ED })
  if (startTime && !TIME_RE.test(startTime)) issues.push({ id: 'start_time', title: 'Invalid Start Time', message: 'Enter the start time as HH:MM.', ...ED })
  if (endTime && !TIME_RE.test(endTime))     issues.push({ id: 'end_time', title: 'Invalid End Time', message: 'Enter the end time as HH:MM.', ...ED })
  const startOk = startDate && validDate(startDate), endOk = endDate && validDate(endDate)
  if (startOk && endOk && minutes(endDate, endTime, true) < minutes(startDate, startTime)) {
    issues.push({ id: 'schedule_order', title: 'Event Ends Before It Starts', message: 'The end date and time must be after the start.', ...ED })
  }
  if (mode === 'publish' && startOk) {
    const lastDay = endOk ? endDate : startDate
    if (lastDay < todayIn(str(schedule.timezone))) {
      issues.push({ id: 'schedule_past', title: 'Event Already Over', message: 'The event’s dates are in the past. Update the schedule before publishing.', ...ED })
    }
  }

  // ── Online / hybrid link ───────────────────────────────────────────────────────
  const meetingUrl = str(online.meetingUrl)
  if (meetingUrl && !/^https?:\/\/[^\s]+$/i.test(meetingUrl)) {
    issues.push({ id: 'meeting_url', title: 'Invalid Meeting Link', message: 'The online meeting link must start with http:// or https://.', ...ED })
  }

  // ── Registration window ───────────────────────────────────────────────────────
  const regOpen = str(pricing.registrationOpenDate), regEnd = str(pricing.registrationEndDate)
  const regOpenM = regOpen ? localMinutes(regOpen) : null, regEndM = regEnd ? localMinutes(regEnd, true) : null
  if (regOpen && regOpenM === null) issues.push({ id: 'reg_open', title: 'Invalid Registration Open Date', message: 'Enter a real date for when registration opens.', ...PP })
  if (regEnd && regEndM === null)   issues.push({ id: 'reg_end', title: 'Invalid Registration Close Date', message: 'Enter a real date for when registration closes.', ...PP })
  if (regOpenM !== null && regEndM !== null && regEndM < regOpenM) {
    issues.push({ id: 'reg_order', title: 'Registration Closes Before It Opens', message: 'Registration must open before it closes.', ...PP })
  }
  const eventEndM = startOk ? (endOk ? minutes(endDate, endTime, true) : minutes(startDate, '', true)) : null
  if (regOpenM !== null && eventEndM !== null && regOpenM > eventEndM) {
    issues.push({ id: 'reg_after_event', title: 'Registration Opens After The Event', message: 'Registration must open before the event ends.', ...PP })
  }

  // ── Passes ─────────────────────────────────────────────────────────────────────
  const isFree = str(pricing.eventType) === 'free'
  const passes = Array.isArray(pricing.passes) ? pricing.passes.map(rec) : []
  for (const p of passes) {
    const id = str(p.id) || 'pass'
    const label = str(p.name) || 'A pass'
    const bad = (key: string, title: string, message: string) => issues.push({ id: `${key}:${id}`, title, message: `${label}: ${message}`, ...PP })
    if (str(p.name).length > 120) bad('pass_name', 'Pass Name Too Long', 'keep the name under 120 characters.')
    const price = p.price
    if (typeof price !== 'number' || !Number.isFinite(price) || price < 0 || price > MAX_PRICE_RUPEES || !twoDecimals(price)) {
      bad('pass_price', 'Invalid Pass Price', 'the price must be ₹0 or more, with at most 2 decimal places.')
    } else if (isFree && price > 0) {
      bad('pass_price_free', 'Paid Pass On A Free Event', 'a free event cannot have a priced pass.')
    }
    if (p.unlimited !== true) {
      const q = p.quantity
      if (typeof q !== 'number' || !Number.isInteger(q) || q < 1 || q > MAX_QUANTITY) bad('pass_quantity', 'Invalid Pass Quantity', 'the quantity must be a whole number of at least 1.')
    }
    const minP = p.minPurchase, maxP = p.maxPurchase
    const intOrAbsent = (v: unknown) => v === undefined || v === null || (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 1000)
    if (!intOrAbsent(minP) || !intOrAbsent(maxP)) bad('pass_purchase_limits', 'Invalid Purchase Limits', 'minimum and maximum per order must be whole numbers of at least 1.')
    else if (typeof minP === 'number' && typeof maxP === 'number' && minP > maxP) bad('pass_purchase_order', 'Minimum Above Maximum', 'the minimum per order is above the maximum.')
    const ss = str(p.salesStartDate), se = str(p.salesEndDate)
    const ssM = ss ? localMinutes(ss) : null, seM = se ? localMinutes(se, true) : null
    if ((ss && ssM === null) || (se && seM === null)) bad('pass_sales_dates', 'Invalid Sales Dates', 'enter real dates for the sales window.')
    else if (ssM !== null && seM !== null && seM < ssM) bad('pass_sales_order', 'Sales Close Before They Open', 'the sales window must open before it closes.')
    if (p.earlyBirdEnabled === true) {
      const eb = p.earlyBirdPrice
      if (typeof eb !== 'number' || !Number.isFinite(eb) || eb <= 0 || !twoDecimals(eb) || (typeof price === 'number' && eb > price)) {
        bad('pass_early_bird', 'Invalid Early-Bird Price', 'the early-bird price must be above ₹0 and not above the regular price.')
      }
      const ebEnd = str(p.earlyBirdEndDate)
      if (ebEnd && localMinutes(ebEnd) === null) bad('pass_early_bird_end', 'Invalid Early-Bird End', 'enter a real early-bird end date.')
    }
  }
  return issues
}
