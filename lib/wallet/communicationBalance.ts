// lib/wallet/communicationBalance.ts
// Where the COMMUNICATION BALANCE (organizerWallets — the pay-as-you-go balance that broadcasts,
// WhatsApp beyond a prepaid allowance and pay-as-you-go certificates are charged to) is managed and
// topped up. Decided 2026-10-02: the event-wise Wallet no longer has a general "Add Funds"; the
// existing top-up flow lives, unchanged, on the Communications › Billing tab.

export const COMMUNICATION_BALANCE_HREF = '/dashboard/communications?tab=billing'
