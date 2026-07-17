// Integrations — compact trust content. This section does NOT re-explain features
// (Payments, Certificates, QR, CSV, etc. are covered elsewhere). It only signals
// that RegisterDesk connects with the services teams already use. Named services
// are the REAL infrastructure the platform runs on (or clearly-labelled roadmap
// items) — no fabricated logos or "hundreds of integrations".

export const INTEGRATIONS_HEADING = {
  eyebrow:     'Integrations',
  title:       'Works with the tools you already use',
  description: 'Connect RegisterDesk with your existing payment, communication, and infrastructure services—without changing your workflow.',
}

export type IntegrationChipStatus = 'live' | 'coming_soon'

export interface IntegrationChip {
  id:     string
  name:   string
  status: IntegrationChipStatus
  /** Maps to a lucide icon in the section component's ICONS table. */
  icon:   string
}

export const INTEGRATION_CHIPS: IntegrationChip[] = [
  // Live today
  { id: 'ses',      name: 'Amazon SES', status: 'live',        icon: 'mail' },
  { id: 'razorpay', name: 'Razorpay',   status: 'live',        icon: 'card' },
  { id: 'firebase', name: 'Firebase',   status: 'live',        icon: 'firebase' },
  { id: 'excel',    name: 'Excel',      status: 'live',        icon: 'excel' },
  { id: 'csv',      name: 'CSV',        status: 'live',        icon: 'csv' },
  // Coming soon
  { id: 'whatsapp', name: 'WhatsApp',   status: 'coming_soon', icon: 'whatsapp' },
  { id: 'rest-api', name: 'REST API',   status: 'coming_soon', icon: 'api' },
  { id: 'webhooks', name: 'Webhooks',   status: 'coming_soon', icon: 'webhook' },
]

export const INTEGRATIONS_NOTE = 'More integrations are continuously being added as RegisterDesk evolves.'
