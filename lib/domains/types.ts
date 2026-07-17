// Custom domain types — client-safe (pure types + DNS target const).

export type CustomDomainStatus = 'pending' | 'verified' | 'failed'
export type CustomDomainSslStatus = 'pending' | 'active' | 'failed'

// The CNAME target organizers point their domain at.
export const DOMAIN_DNS_TARGET = 'registerdesk-domain-verification.vercel.app'
// TXT record name prefix used for ownership verification.
export const DOMAIN_TXT_PREFIX = '_registerdesk-verification'

export interface DnsRecord {
  type:  'CNAME' | 'TXT'
  name:  string
  value: string
}

export interface DomainConfig {
  customDomain:           string | null
  customDomainStatus:     CustomDomainStatus | null
  customDomainVerifiedAt: string | null
  customDomainDnsTarget:  string | null
  customDomainSslStatus:  CustomDomainSslStatus | null
  // Required DNS records the organizer must add (present when a domain is set).
  records:                DnsRecord[]
  lastError:              string | null
}

// Admin list row.
export interface AdminDomainRow {
  organizerUid: string
  customDomain: string
  status:       CustomDomainStatus
  sslStatus:    CustomDomainSslStatus | null
  verifiedAt:   string | null
}
