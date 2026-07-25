// Country dial codes for the organizer Account Mobile Number (RD-AUTH-02 Phase 2/3).
//
// This drives the country-code select on signup and in Settings → Account. It is a
// PRESENTATION list only — normalization/validation is owned by lib/communication/phone.ts
// (a country-agnostic normalizer). `dialCode` is stored on the account as
// users/{uid}.mobile.countryCode; `callingDigits` is passed to normalizePhoneNumber as
// the default calling code so a bare national number is expanded to E.164.
//
// India-first (platform default), then the most common RegisterDesk markets. Add rows
// here only — no other file needs to change.

export interface CountryDialCode {
  /** ISO-3166 alpha-2 — used as the stable option key. */
  iso:   string
  /** Human label for the option. */
  label: string
  /** Dial code WITH '+', stored as mobile.countryCode (e.g. '+91'). */
  dialCode: string
  /** Dial code digits only, passed to normalizePhoneNumber (e.g. '91'). */
  callingDigits: string
}

export const COUNTRY_DIAL_CODES: CountryDialCode[] = [
  { iso: 'IN', label: 'India (+91)',            dialCode: '+91',  callingDigits: '91'  },
  { iso: 'US', label: 'United States (+1)',     dialCode: '+1',   callingDigits: '1'   },
  { iso: 'GB', label: 'United Kingdom (+44)',   dialCode: '+44',  callingDigits: '44'  },
  { iso: 'AE', label: 'UAE (+971)',             dialCode: '+971', callingDigits: '971' },
  { iso: 'SG', label: 'Singapore (+65)',        dialCode: '+65',  callingDigits: '65'  },
  { iso: 'AU', label: 'Australia (+61)',        dialCode: '+61',  callingDigits: '61'  },
  { iso: 'CA', label: 'Canada (+1)',            dialCode: '+1',   callingDigits: '1'   },
  { iso: 'DE', label: 'Germany (+49)',          dialCode: '+49',  callingDigits: '49'  },
  { iso: 'FR', label: 'France (+33)',           dialCode: '+33',  callingDigits: '33'  },
  { iso: 'ZA', label: 'South Africa (+27)',     dialCode: '+27',  callingDigits: '27'  },
  { iso: 'NG', label: 'Nigeria (+234)',         dialCode: '+234', callingDigits: '234' },
  { iso: 'MY', label: 'Malaysia (+60)',         dialCode: '+60',  callingDigits: '60'  },
]

/** Default selection — the platform's primary market (India). */
export const DEFAULT_DIAL_CODE = '+91'

/** Resolve the calling-digits for a stored dialCode; falls back to India ('91'). */
export function callingDigitsForDialCode(dialCode: string): string {
  return COUNTRY_DIAL_CODES.find(c => c.dialCode === dialCode)?.callingDigits ?? '91'
}
