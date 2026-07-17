// White-label branding types — client-safe (types + validation constants).
//
// These fields live on the EXISTING users/{uid}.branding object (alongside the
// legacy logoUrl/certSignatureUrl/emailHeaderUrl/primaryColor) and are merged via
// field-path updates so nothing pre-existing is overwritten.

export interface Branding {
  logoUrl:                  string | null
  faviconUrl:               string | null
  primaryColor:             string | null
  secondaryColor:           string | null
  companyName:              string | null
  emailSenderName:          string | null
  hideRegisterDeskBranding: boolean
}

export const DEFAULT_BRANDING: Branding = {
  logoUrl:                  null,
  faviconUrl:               null,
  primaryColor:             null,
  secondaryColor:           null,
  companyName:              null,
  emailSenderName:          null,
  hideRegisterDeskBranding: false,
}

export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/
export const MAX_COMPANY_NAME_LEN = 100
export const MAX_SENDER_NAME_LEN  = 100

// Resolved branding for public surfaces: only the fields renderers need.
export interface PublicBranding {
  logoUrl:                  string | null
  primaryColor:             string | null
  secondaryColor:           string | null
  companyName:              string | null
  emailSenderName:          string | null
  hideRegisterDeskBranding: boolean
}
