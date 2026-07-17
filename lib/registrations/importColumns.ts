// Participant-column selection for the bulk-import template (RM-2.2F). PURE —
// no Firebase, no I/O — so the route and its regression test derive the SAME
// field model.
//
// The standard Full Name / Email / Phone columns each represent exactly ONE
// identity field, resolved with the SAME rule the validator's
// importValidation.buildColumnResolver uses:
//   Full Name → the first field labelled "name"/"full name"
//   Email     → the first `email`-type field
//   Phone     → the first `mobile`-type field
// ONLY those exact field IDs are skipped. Every ADDITIONAL email/mobile field
// (Emergency Contact Number, Guardian Mobile, Alternate Email, …) is a distinct
// field the standard columns do NOT represent, so it must be exported as its own
// column — otherwise validation requires a value the template can't supply.

export interface ImportFormField {
  id?:             string
  label?:          string
  type?:           string
  required?:       boolean
  visible?:        boolean
  placeholder?:    string
  helperText?:     string
  options?:        unknown
  validation?:     Record<string, unknown>
  passVisibility?: 'all' | string[]
}

export interface ImportFormRule {
  sourceFieldId?: string
  operator?:      string
  value?:         string
  action?:        string
  targetFieldId?: string
  enabled?:       boolean
}

export interface ImportFormSection {
  order?:  unknown
  fields?: ImportFormField[]
}

// Labels already carried by a standard column — a form field with one of these
// exact labels is never re-exported (avoids a duplicate header, and mirrors the
// identity headers buildColumnResolver maps: name/full name/email/phone/mobile/pass).
const RESERVED_HEADERS = new Set(['name', 'full name', 'email', 'phone', 'mobile', 'pass'])

/**
 * The exact field IDs represented by the standard Full Name / Email / Phone
 * columns — identical resolution to importValidation.buildColumnResolver.
 */
export function identityFieldIds(allFields: ImportFormField[]): Set<string> {
  let nameId:   string | null = null
  let emailId:  string | null = null
  let mobileId: string | null = null
  for (const f of allFields) {
    if (typeof f?.id !== 'string' || typeof f?.label !== 'string') continue
    const l = f.label.trim().toLowerCase()
    if (!nameId   && (l === 'name' || l === 'full name')) nameId   = f.id
    if (!emailId  && f.type === 'email')                  emailId  = f.id
    if (!mobileId && f.type === 'mobile')                 mobileId = f.id
  }
  return new Set([nameId, emailId, mobileId].filter((v): v is string => v !== null))
}

/** True when a field is shown on the form: base-visible, or made visible by a rule. */
export function isImportFieldShown(f: ImportFormField, rules: ImportFormRule[]): boolean {
  if (f.visible !== false) return true
  return rules.some(r => r?.enabled !== false && r?.targetFieldId === f.id && r?.action === 'show')
}

/**
 * The custom fields exported as their own Participants columns, in form order:
 * every shown field that is NOT one of the identity fields and does not collide
 * with a standard header, each appearing exactly once.
 */
export function selectDynamicImportFields(
  sections: ImportFormSection[],
  rules:    ImportFormRule[],
): ImportFormField[] {
  const identity = identityFieldIds(sections.flatMap(s => s?.fields ?? []))
  const used = new Set<string>()
  const out: ImportFormField[] = []
  for (const s of sections) {
    for (const f of s?.fields ?? []) {
      if (typeof f?.id !== 'string' || typeof f?.label !== 'string' || !f.label.trim()) continue
      if (identity.has(f.id)) continue                    // already represented by a standard column
      if (!isImportFieldShown(f, rules)) continue          // hidden and not conditionally shown
      const key = f.label.trim().toLowerCase()
      if (RESERVED_HEADERS.has(key) || used.has(key)) continue   // never duplicate a column header
      used.add(key)
      out.push(f)
    }
  }
  return out
}
