// Organizer Brand Kit (GA-6 S4). One per organizer — the reusable brand identity
// that flows into every certificate/print project. Pure types + validation; no SDK.
// Additive: an organizer with no brand kit simply has none (all fields optional).

export interface BrandKit {
  organizerUid:     string
  // Asset URLs (uploaded via the EXISTING organizer-asset upload flow; overwrite-in-place).
  logoUrl:          string   // '' = unset
  secondaryLogoUrl: string
  sealUrl:          string
  signatureUrl:     string
  // Brand tokens.
  primaryColor:     string   // #RRGGBB
  secondaryColor:   string
  font:             'helvetica' | 'times' | 'courier'
  footer:           string
  website:          string
  supportEmail:     string
  phone:            string
  updatedAt?:       unknown   // Firestore Timestamp
  updatedBy?:       string
}

/** The organizer-editable subset (server owns organizerUid + timestamps). */
export type BrandKitInput = Omit<BrandKit, 'organizerUid' | 'updatedAt' | 'updatedBy'>

export function defaultBrandKit(): BrandKitInput {
  return {
    logoUrl: '', secondaryLogoUrl: '', sealUrl: '', signatureUrl: '',
    primaryColor: '#111827', secondaryColor: '#6b7280', font: 'helvetica',
    footer: '', website: '', supportEmail: '', phone: '',
  }
}

const isStr = (v: unknown): v is string => typeof v === 'string'
const isHex = (v: unknown): boolean => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)
const isUrlOrEmpty = (v: unknown): boolean => v === '' || (typeof v === 'string' && /^https?:\/\//.test(v))

/** Validates a brand-kit body into a clean input (no undefined keys — Firestore-safe). */
export function validateBrandKit(raw: unknown): { ok: true; value: BrandKitInput } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'Body must be an object' }
  const r = raw as Record<string, unknown>
  const d = defaultBrandKit()
  const str = (k: keyof BrandKitInput, max = 300): string => {
    const v = r[k]
    return isStr(v) ? v.slice(0, max) : (d[k] as string)
  }
  for (const k of ['logoUrl', 'secondaryLogoUrl', 'sealUrl', 'signatureUrl'] as const) {
    if (r[k] !== undefined && !isUrlOrEmpty(r[k])) return { ok: false, error: `${k} must be a URL` }
  }
  if (r.primaryColor !== undefined && !isHex(r.primaryColor))     return { ok: false, error: 'primaryColor must be #RRGGBB' }
  if (r.secondaryColor !== undefined && !isHex(r.secondaryColor)) return { ok: false, error: 'secondaryColor must be #RRGGBB' }
  const font = r.font === 'times' || r.font === 'courier' ? r.font : 'helvetica'
  if (r.supportEmail !== undefined && r.supportEmail !== '' && !(isStr(r.supportEmail) && r.supportEmail.includes('@'))) {
    return { ok: false, error: 'supportEmail must be a valid email' }
  }
  return {
    ok: true,
    value: {
      logoUrl: str('logoUrl'), secondaryLogoUrl: str('secondaryLogoUrl'),
      sealUrl: str('sealUrl'), signatureUrl: str('signatureUrl'),
      primaryColor: isHex(r.primaryColor) ? r.primaryColor as string : d.primaryColor,
      secondaryColor: isHex(r.secondaryColor) ? r.secondaryColor as string : d.secondaryColor,
      font, footer: str('footer', 500), website: str('website'),
      supportEmail: str('supportEmail'), phone: str('phone', 40),
    },
  }
}
