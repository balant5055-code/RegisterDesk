// RD-ATTENDEE-03A M3 — the ONE source of pricing / tax wording, so Event Details,
// Register, Checkout and Confirmation always say the same thing. Prices are authored
// tax-inclusive across the platform; edit the phrasing here and every surface updates.

export const TAX_INCLUSIVE_NOTE       = 'All prices include taxes'

/**
 * RD-FEE-RESTORE-03 — shown INSTEAD of the tax note when the event collects platform fees
 * from the attendee.
 *
 * "All prices include taxes" is false under attendee-pays: the summary shows the ticket, and
 * platform fees are added on top at checkout. Saying the opposite beside a total that is about
 * to grow is the specific thing that made a ₹1 ticket look like a ₹1 charge.
 *
 * It promises itemisation because that is what happens — the payment dialog shows every line
 * from the server's own breakdown before anything is charged.
 */
export const FEES_ADDED_AT_CHECKOUT_NOTE = 'Platform fees are added at checkout and itemised before payment opens'
export const TAX_INCLUSIVE_NOTE_SHORT = 'Incl. taxes'
