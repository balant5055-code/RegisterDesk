// RD-PLATFORM-COMMS-01 Phase 4E — the canonical platform-template VARIABLE registry.
//
// ONE source of truth for every variable a RegisterDesk → Organizer template may expose.
// Templates reference variables by id; anything outside this registry is an "unknown
// variable" and is flagged by template health. Pure + isomorphic. Read-only — this only
// describes the variable contract + sample values for preview; it renders/sends nothing.

export type VariableCategory = 'recipient' | 'organization' | 'event' | 'billing' | 'security' | 'system'

export interface TemplateVariable {
  id:       string          // canonical id, e.g. 'OrganizerName'
  token:    string          // the mustache token shown in templates, e.g. '{{OrganizerName}}'
  label:    string
  example:  string          // sample value used for read-only preview
  category: VariableCategory
}

function v(id: string, label: string, example: string, category: VariableCategory): TemplateVariable {
  return { id, token: `{{${id}}}`, label, example, category }
}

/** THE canonical variable registry. */
export const TEMPLATE_VARIABLES: TemplateVariable[] = [
  v('RecipientName',     'Recipient name',      'Priya Sharma',                 'recipient'),
  v('OrganizerName',     'Organizer name',      'Priya Sharma',                 'recipient'),
  v('OrganizationName',  'Organization name',   'Acme Events',                  'organization'),
  v('DashboardUrl',      'Dashboard URL',       'https://registerdesk.app/dashboard', 'system'),
  v('SupportEmail',      'Support email',       'support@registerdesk.app',     'system'),
  v('EventName',         'Event name',          'TechConf 2026',                'event'),
  v('ReviewNote',        'Review note',         'Please add a venue address.',  'event'),
  v('LicenseName',       'License name',        'Professional',                 'billing'),
  v('Amount',            'Amount',              '₹1,499',                       'billing'),
  v('InvoiceNumber',     'Invoice number',      'INV-2026-000123',              'billing'),
  v('SettlementId',      'Settlement id',       'STL-2026-00045',               'billing'),
  v('AccountHolderName', 'Account holder name', 'Priya Sharma',                 'billing'),
  v('VerificationCode',  'Verification code',   '482913',                       'security'),
]

const BY_ID: Record<string, TemplateVariable> = Object.fromEntries(TEMPLATE_VARIABLES.map(x => [x.id, x]))

export function getVariable(id: string): TemplateVariable | undefined { return BY_ID[id] }
export function isKnownVariable(id: string): boolean { return id in BY_ID }
