'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { onAuthStateChanged, sendPasswordResetEmail } from 'firebase/auth'
import type { User } from 'firebase/auth'
import { auth }                        from '@/lib/firebase/auth'
import { uploadOrganizerAsset }        from '@/lib/firebase/storage'
import type { OrganizerSettings }      from '@/app/api/organizer/settings/route'
import {
  Building2, Palette, CalendarDays, Bell, User as UserIcon,
  Upload, X, Check, Loader2, AlertCircle, ChevronDown,
  ShieldCheck, Globe, LogOut, Activity,
} from 'lucide-react'
import { VerifiedBadge } from '@/components/auth/VerifiedBadge'
import { cn }                          from '@/lib/utils/cn'
import { ImageCropperModal }           from '@/components/ui/ImageCropperModal'
import type { CropConfig }             from '@/components/ui/ImageCropperModal'
import { useToast }                    from '@/components/ui/Toast'

// ─── Primitive components ─────────────────────────────────────────────────────

function Section({
  icon: Icon, title, description, children,
}: {
  icon: React.ElementType; title: string; description: string; children: React.ReactNode
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex items-center gap-3 border-b border-border px-5 py-4">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/[0.09]">
          <Icon className="size-4 text-primary" aria-hidden />
        </div>
        <div>
          <h2 className="text-[16px] font-bold text-foreground">{title}</h2>
          <p className="text-[13px] text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="space-y-5 px-5 py-5">{children}</div>
    </div>
  )
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </span>
  )
}

function TextInput({
  label, value, onChange, type = 'text', placeholder, hint, disabled,
}: {
  label: string; value: string; onChange?: (v: string) => void
  type?: string; placeholder?: string; hint?: string; disabled?: boolean
}) {
  return (
    <div>
      <Label>{label}</Label>
      <input
        type={type}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={e => onChange?.(e.target.value)}
        className={cn(
          'h-10 w-full rounded-lg border border-border bg-card px-3 text-[14px] text-foreground placeholder:text-muted-foreground',
          'focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/25',
          disabled && 'cursor-not-allowed opacity-55',
        )}
      />
      {hint && <p className="mt-1 text-[13px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

function SelectInput({
  label, value, onChange, options, hint,
}: {
  label: string; value: string; onChange: (v: string) => void
  options: { value: string; label: string }[]; hint?: string
}) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="relative">
        <select
          value={value}
          onChange={e => onChange(e.target.value)}
          className={cn(
            'h-10 w-full appearance-none rounded-lg border border-border bg-card px-3 pr-8 text-[14px] text-foreground',
            'focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/25',
          )}
        >
          {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      </div>
      {hint && <p className="mt-1 text-[13px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

function Toggle({
  label, description, checked, onChange,
}: {
  label: string; description?: string; checked: boolean; onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-0.5">
      <div>
        <p className="text-[14px] font-medium text-foreground">{label}</p>
        {description && <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-primary/30',
          checked ? 'bg-primary' : 'bg-muted',
        )}
      >
        <span
          className={cn(
            'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform duration-200',
            checked ? 'translate-x-4' : 'translate-x-0',
          )}
        />
      </button>
    </div>
  )
}

function ImageUpload({
  label, hint, preview, onFile, onClear, shape = 'square', cropConfig,
}: {
  label: string; hint?: string; preview: string | null
  onFile: (file: File, previewUrl: string) => void
  onClear: () => void
  shape?: 'square' | 'wide'
  cropConfig?: CropConfig
}) {
  const inputRef                          = useRef<HTMLInputElement>(null)
  const [rawSrc,      setRawSrc]          = useState<string | null>(null)
  const [showCropper, setShowCropper]     = useState(false)

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const src = ev.target?.result as string
      if (cropConfig) {
        setRawSrc(src)
        setShowCropper(true)
      } else {
        onFile(file, src)
      }
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  function handleCropApply(croppedFile: File, previewUrl: string) {
    setShowCropper(false)
    setRawSrc(null)
    onFile(croppedFile, previewUrl)
  }

  function handleCropCancel() {
    setShowCropper(false)
    setRawSrc(null)
  }

  return (
    <>
      {/* Cropper modal — fixed overlay, renders above the whole page */}
      {showCropper && rawSrc && cropConfig && (
        <ImageCropperModal
          imageSrc={rawSrc}
          config={cropConfig}
          onApply={handleCropApply}
          onCancel={handleCropCancel}
        />
      )}

      <div>
        <Label>{label}</Label>
        <div className="flex items-center gap-4">
          {preview ? (
            <div className="relative shrink-0">
              <img
                src={preview}
                alt=""
                className={cn(
                  'border border-border object-cover',
                  shape === 'square' ? 'h-16 w-16 rounded-xl' : 'h-12 w-48 rounded-lg',
                )}
              />
              <button
                type="button"
                onClick={onClear}
                className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-destructive text-white shadow"
                aria-label="Remove image"
              >
                <X className="size-3" aria-hidden />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className={cn(
                'flex shrink-0 cursor-pointer items-center justify-center rounded-xl border-2 border-dashed border-border transition-colors hover:border-primary/40',
                shape === 'square' ? 'h-16 w-16' : 'h-12 w-48',
              )}
            >
            <Upload className="size-5 text-muted-foreground" aria-hidden />
          </button>
        )}
        <div>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="text-[13px] font-medium text-primary hover:underline underline-offset-2"
          >
            {preview ? 'Change' : 'Upload image'}
          </button>
          {hint && <p className="mt-0.5 text-[13px] text-muted-foreground">{hint}</p>}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          className="sr-only"
          onChange={handleChange}
        />
      </div>
    </div>
    </>
  )
}

function ColorPicker({
  label, value, onChange, hint,
}: {
  label: string; value: string; onChange: (v: string) => void; hint?: string
}) {
  const nativeRef = useRef<HTMLInputElement>(null)
  return (
    <div>
      <Label>{label}</Label>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => nativeRef.current?.click()}
          className="size-10 shrink-0 rounded-lg border border-border shadow-sm transition-transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-primary/30"
          style={{ backgroundColor: value }}
          aria-label="Open color picker"
        />
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          className="h-10 w-28 rounded-lg border border-border bg-card px-3 font-mono text-[13px] text-foreground focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/25"
          placeholder="#6366f1"
        />
        <input
          ref={nativeRef}
          type="color"
          value={value.startsWith('#') ? value : '#6366f1'}
          onChange={e => onChange(e.target.value)}
          className="sr-only"
        />
      </div>
      {hint && <p className="mt-1.5 text-[13px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

function SaveRow({
  onSave, saving, saved, label = 'Save',
}: {
  onSave: () => void; saving: boolean; saved: boolean; label?: string
}) {
  return (
    <div className="flex items-center gap-3 pt-1">
      <button
        type="button"
        onClick={onSave}
        disabled={saving}
        className="flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {saving && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
        {label}
      </button>
      {saved && (
        <span className="flex items-center gap-1.5 text-[13px] text-emerald-600">
          <Check className="size-3.5" /> Saved
        </span>
      )}
    </div>
  )
}

// ─── Branding preview card ────────────────────────────────────────────────────

function BrandingPreview({
  orgName, logoPreview, color,
}: { orgName: string; logoPreview: string | null; color: string }) {
  const initial = (orgName || 'O').charAt(0).toUpperCase()
  return (
    <div>
      <Label>Preview</Label>
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="h-1.5 w-full" style={{ backgroundColor: color }} />
        <div className="px-4 py-3.5">
          <div className="flex items-center gap-2.5">
            {logoPreview ? (
              <img src={logoPreview} alt="" className="size-8 rounded-lg object-cover" />
            ) : (
              <div
                className="flex size-8 shrink-0 items-center justify-center rounded-lg text-[12px] font-bold text-white"
                style={{ backgroundColor: color }}
              >
                {initial}
              </div>
            )}
            <div>
              <p className="text-[13px] font-semibold text-foreground leading-none">
                {orgName || 'Your Organization'}
              </p>
              <p className="mt-0.5 text-[12px] text-muted-foreground">Ticket · Certificate</p>
            </div>
          </div>
          <div className="mt-3 space-y-2">
            <div className="h-2 w-3/4 rounded-full bg-muted" />
            <div className="h-2 w-1/2 rounded-full bg-muted" />
            <div
              className="mt-2 h-7 w-24 rounded-lg flex items-center justify-center"
              style={{ backgroundColor: `${color}18` }}
            >
              <div className="h-1.5 w-12 rounded-full" style={{ backgroundColor: color }} />
            </div>
          </div>
        </div>
      </div>
      <p className="mt-1.5 text-[12px] text-muted-foreground">Updates as you change your settings above.</p>
    </div>
  )
}

// ─── Browser detector ────────────────────────────────────────────────────────

function parseBrowser(ua: string): string {
  if (/Edg\//i.test(ua))    return 'Microsoft Edge'
  if (/OPR\//i.test(ua))    return 'Opera'
  if (/Chrome\//i.test(ua)) return 'Google Chrome'
  if (/Firefox\//i.test(ua)) return 'Mozilla Firefox'
  if (/Safari\//i.test(ua)) return 'Safari'
  return 'Unknown Browser'
}

function parseOS(ua: string): string {
  if (/Windows/i.test(ua))   return 'Windows'
  if (/iPhone|iPad/i.test(ua)) return 'iOS'
  if (/Mac OS X/i.test(ua))  return 'macOS'
  if (/Android/i.test(ua))   return 'Android'
  if (/Linux/i.test(ua))     return 'Linux'
  return 'Unknown OS'
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TIMEZONES = [
  { value: 'Asia/Kolkata',     label: 'India (IST, UTC+5:30)' },
  { value: 'Asia/Dubai',       label: 'Dubai (GST, UTC+4)' },
  { value: 'Asia/Singapore',   label: 'Singapore (SGT, UTC+8)' },
  { value: 'Asia/Kuala_Lumpur', label: 'Kuala Lumpur (MYT, UTC+8)' },
  { value: 'Asia/Bangkok',     label: 'Bangkok (ICT, UTC+7)' },
  { value: 'Europe/London',    label: 'London (GMT/BST)' },
  { value: 'Europe/Paris',     label: 'Central Europe (CET, UTC+1)' },
  { value: 'America/New_York', label: 'New York (EST/EDT)' },
  { value: 'America/Los_Angeles', label: 'Los Angeles (PST/PDT)' },
  { value: 'UTC',              label: 'UTC (no offset)' },
]

const CURRENCIES = [
  { value: 'INR', label: 'Indian Rupee (₹)' },
  { value: 'USD', label: 'US Dollar ($)' },
  { value: 'EUR', label: 'Euro (€)' },
  { value: 'GBP', label: 'British Pound (£)' },
  { value: 'SGD', label: 'Singapore Dollar (S$)' },
  { value: 'AED', label: 'UAE Dirham (AED)' },
]

const REG_CLOSE_RULES = [
  { value: 'event_start',  label: 'When the event starts' },
  { value: '1h_before',    label: '1 hour before the event' },
  { value: '24h_before',   label: '24 hours before the event' },
  { value: 'manual',       label: 'Manually — I will close it' },
]

const VISIBILITY_OPTIONS = [
  { value: 'public',   label: 'Public — anyone can find and register' },
  { value: 'unlisted', label: 'Unlisted — only people with the link' },
  { value: 'private',  label: 'Private — invite only' },
]

const CROP_LOGO: CropConfig = {
  label:        'Crop Organization Logo',
  aspect:       1,
  outputWidth:  512,
  outputHeight: 512,
}

const CROP_CERT_SIG: CropConfig = {
  label:        'Crop Certificate Signature',
  aspect:       3,
  outputWidth:  1200,
  outputHeight: 400,
}

const CROP_EMAIL_HDR: CropConfig = {
  label:        'Crop Email Header Image',
  aspect:       16 / 9,
  outputWidth:  1200,
  outputHeight: 675,
}

// ─── AccountHealthPanel ───────────────────────────────────────────────────────

interface HealthCheck {
  label:    string
  done:     boolean
  points:   number
  action?:  string
  href?:    string
}

function AccountHealthPanel({
  emailVerified, orgName, logoUrl, orgWebsite, orgSupportEmail,
}: {
  emailVerified:  boolean
  orgName:        string
  logoUrl:        string | null
  orgWebsite:     string
  orgSupportEmail: string
}) {
  const checks: HealthCheck[] = [
    { label: 'Email verified',            done: emailVerified,         points: 50, action: 'Verify email', href: '/verify-email' },
    { label: 'Organization name set',     done: !!orgName.trim(),      points: 15 },
    { label: 'Logo uploaded',             done: !!logoUrl,             points: 15, action: 'Upload logo' },
    { label: 'Website added',             done: !!orgWebsite.trim(),   points: 10 },
    { label: 'Support email configured',  done: !!orgSupportEmail.trim(), points: 10 },
  ]

  const score    = checks.reduce((acc, c) => acc + (c.done ? c.points : 0), 0)
  const maxScore = checks.reduce((acc, c) => acc + c.points, 0)
  const pct      = Math.round((score / maxScore) * 100)

  const scoreColor =
    pct >= 80 ? 'text-emerald-600' :
    pct >= 50 ? 'text-amber-600' :
    'text-destructive'

  const barColor =
    pct >= 80 ? 'bg-emerald-500' :
    pct >= 50 ? 'bg-amber-400' :
    'bg-destructive'

  const nextAction = checks.find(c => !c.done && c.action)

  return (
    <div className="rounded-xl border border-border bg-muted/20 px-4 py-4">
      <div className="mb-3 flex items-center gap-2">
        <Activity className="size-4 text-primary shrink-0" aria-hidden />
        <p className="text-[13px] font-semibold text-foreground">Account Health</p>
        <VerifiedBadge verified={emailVerified} size="sm" className="ml-auto" />
      </div>

      {/* Score + bar */}
      <div className="mb-3 flex items-center gap-3">
        <span className={cn('text-2xl font-bold tabular-nums leading-none', scoreColor)}>
          {pct}
        </span>
        <div className="flex-1">
          <div className="mb-1 flex justify-between text-[12px] text-muted-foreground">
            <span>Health score</span>
            <span>{score}/{maxScore} pts</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-border">
            <div
              className={cn('h-full rounded-full transition-all duration-500', barColor)}
              style={{ width: `${pct}%` }}
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`Account health ${pct}%`}
            />
          </div>
        </div>
      </div>

      {/* Checklist */}
      <ul className="space-y-1.5">
        {checks.map(c => (
          <li key={c.label} className="flex items-center gap-2">
            <span
              aria-hidden
              className={cn(
                'flex size-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold',
                c.done
                  ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              {c.done ? '✓' : '○'}
            </span>
            <span className={cn('text-[12px]', c.done ? 'text-foreground' : 'text-muted-foreground')}>
              {c.label}
            </span>
            <span className="ml-auto text-[12px] text-muted-foreground">+{c.points}</span>
          </li>
        ))}
      </ul>

      {/* Recommended action */}
      {nextAction && (
        <div className="mt-3 rounded-lg border border-primary/20 bg-primary/[0.05] px-3 py-2.5">
          <p className="text-[12px] text-muted-foreground">
            Recommended:{' '}
            {nextAction.href ? (
              <a
                href={nextAction.href}
                className="font-semibold text-primary underline-offset-4 hover:underline"
              >
                {nextAction.action}
              </a>
            ) : (
              <span className="font-semibold text-foreground">{nextAction.action}</span>
            )}
          </p>
        </div>
      )}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { showToast } = useToast()
  const userRef = useRef<User | null>(null)

  // Load state
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Organization Profile
  const [orgName,         setOrgName]         = useState('')
  const [orgWebsite,      setOrgWebsite]       = useState('')
  const [orgSupportEmail, setOrgSupportEmail]  = useState('')
  const [orgSupportPhone, setOrgSupportPhone]  = useState('')
  const [logoFile,        setLogoFile]         = useState<File | null>(null)
  const [logoPreview,     setLogoPreview]      = useState<string | null>(null)
  const [logoUrl,         setLogoUrl]          = useState<string | null>(null)

  // Branding
  const [certSigFile,     setCertSigFile]      = useState<File | null>(null)
  const [certSigPreview,  setCertSigPreview]   = useState<string | null>(null)
  const [certSigUrl,      setCertSigUrl]       = useState<string | null>(null)
  const [emailHdrFile,    setEmailHdrFile]     = useState<File | null>(null)
  const [emailHdrPreview, setEmailHdrPreview]  = useState<string | null>(null)
  const [emailHdrUrl,     setEmailHdrUrl]      = useState<string | null>(null)
  const [primaryColor,    setPrimaryColor]     = useState('#6366f1')

  // Event Defaults
  const [timezone,  setTimezone]  = useState('Asia/Kolkata')
  const [currency,  setCurrency]  = useState('INR')
  const [regClose,  setRegClose]  = useState('event_start')
  const [visibility, setVisibility] = useState('public')

  // Communications
  const [commReg,  setCommReg]  = useState(true)
  const [commUpd,  setCommUpd]  = useState(true)
  const [commCan,  setCommCan]  = useState(true)
  const [commCert, setCommCert] = useState(true)

  // Account
  const [accountName,  setAccountName]  = useState('')
  const [accountEmail, setAccountEmail] = useState('')
  const [resetSent,    setResetSent]    = useState(false)
  const [showDeleteZone,  setShowDeleteZone]  = useState(false)
  const [deleteConfirm,   setDeleteConfirm]   = useState('')
  const [deleting,        setDeleting]        = useState(false)

  // Session info (populated on mount from auth.currentUser)
  const [lastLogin,      setLastLogin]      = useState<string>('')
  const [currentBrowser, setCurrentBrowser] = useState<string>('')
  const [emailVerified,  setEmailVerified]  = useState(false)

  // Section save states
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [saved,  setSaved]  = useState<Record<string, boolean>>({})

  function markSaving(s: string, v: boolean) {
    setSaving(p => ({ ...p, [s]: v }))
  }
  function markSaved(s: string) {
    setSaved(p => ({ ...p, [s]: true }))
    setTimeout(() => setSaved(p => ({ ...p, [s]: false })), 2500)
  }

  // ─── Load settings ──────────────────────────────────────────────────────────

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async user => {
      userRef.current = user
      if (!user) { setLoading(false); return }

      // Populate session info immediately from the user object
      setEmailVerified(user.emailVerified)
      const raw = user.metadata.lastSignInTime
      if (raw) {
        setLastLogin(new Date(raw).toLocaleString(undefined, {
          dateStyle: 'medium', timeStyle: 'short',
        }))
      }
      if (typeof navigator !== 'undefined') {
        setCurrentBrowser(`${parseBrowser(navigator.userAgent)} on ${parseOS(navigator.userAgent)}`)
      }

      try {
        const token = await user.getIdToken()
        const res   = await fetch('/api/organizer/settings', {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) throw new Error('Could not load settings.')
        const { settings: s } = await res.json() as { settings: OrganizerSettings }

        setOrgName(s.organizationName)
        setOrgWebsite(s.website)
        setOrgSupportEmail(s.supportEmail)
        setOrgSupportPhone(s.supportPhone)
        setLogoUrl(s.logoUrl)
        setLogoPreview(s.logoUrl)
        setCertSigUrl(s.certSignatureUrl)
        setCertSigPreview(s.certSignatureUrl)
        setEmailHdrUrl(s.emailHeaderUrl)
        setEmailHdrPreview(s.emailHeaderUrl)
        setPrimaryColor(s.primaryColor)
        setTimezone(s.defaultTimezone)
        setCurrency(s.defaultCurrency)
        setRegClose(s.defaultRegistrationClose)
        setVisibility(s.defaultVisibility)
        setCommReg(s.sendRegistrationConfirmation)
        setCommUpd(s.sendEventUpdates)
        setCommCan(s.sendEventCancellation)
        setCommCert(s.sendCertificateEmails)
        setAccountName(s.name)
        setAccountEmail(s.email)
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : 'Error loading settings.')
      } finally {
        setLoading(false)
      }
    })
    return unsub
  }, [])

  // ─── Shared patch helper ────────────────────────────────────────────────────

  const patch = useCallback(async (section: string, data: Record<string, unknown>) => {
    const user = userRef.current
    if (!user) return
    const token = await user.getIdToken()
    const res   = await fetch('/api/organizer/settings', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ section, data }),
    })
    if (!res.ok) throw new Error('Save failed.')
  }, [])

  // ─── Save handlers ──────────────────────────────────────────────────────────

  async function saveOrganization() {
    const uid = userRef.current?.uid
    if (!uid) return
    markSaving('org', true)
    try {
      let finalLogoUrl = logoUrl
      if (logoFile) {
        finalLogoUrl = await uploadOrganizerAsset(uid, 'logo', logoFile)
        setLogoUrl(finalLogoUrl)
        setLogoFile(null)
      }
      await patch('organization', {
        organizationName: orgName,
        website:     orgWebsite,
        supportEmail: orgSupportEmail,
        supportPhone: orgSupportPhone,
        logoUrl:     finalLogoUrl,
      })
      markSaved('org')
    } catch (e) { showToast(e instanceof Error ? e.message : 'Could not save organization details. Please try again.', 'error') }
    finally { markSaving('org', false) }
  }

  async function saveBranding() {
    const uid = userRef.current?.uid
    if (!uid) return
    markSaving('brand', true)
    try {
      let finalCertSigUrl  = certSigUrl
      let finalEmailHdrUrl = emailHdrUrl
      if (certSigFile) {
        finalCertSigUrl = await uploadOrganizerAsset(uid, 'cert-signature', certSigFile)
        setCertSigUrl(finalCertSigUrl)
        setCertSigFile(null)
      }
      if (emailHdrFile) {
        finalEmailHdrUrl = await uploadOrganizerAsset(uid, 'email-header', emailHdrFile)
        setEmailHdrUrl(finalEmailHdrUrl)
        setEmailHdrFile(null)
      }
      await patch('branding', {
        certSignatureUrl: finalCertSigUrl,
        emailHeaderUrl:   finalEmailHdrUrl,
        primaryColor,
      })
      markSaved('brand')
    } catch (e) { showToast(e instanceof Error ? e.message : 'Could not save branding. Please try again.', 'error') }
    finally { markSaving('brand', false) }
  }

  async function saveDefaults() {
    markSaving('defaults', true)
    try {
      await patch('eventDefaults', {
        defaultTimezone:          timezone,
        defaultCurrency:          currency,
        defaultRegistrationClose: regClose,
        defaultVisibility:        visibility,
      })
      markSaved('defaults')
    } catch (e) { showToast(e instanceof Error ? e.message : 'Could not save event defaults. Please try again.', 'error') }
    finally { markSaving('defaults', false) }
  }

  async function saveCommunications() {
    markSaving('comms', true)
    try {
      await patch('communications', {
        sendRegistrationConfirmation: commReg,
        sendEventUpdates:             commUpd,
        sendEventCancellation:        commCan,
        sendCertificateEmails:        commCert,
      })
      markSaved('comms')
    } catch (e) { showToast(e instanceof Error ? e.message : 'Could not save communication preferences. Please try again.', 'error') }
    finally { markSaving('comms', false) }
  }

  async function saveAccount() {
    markSaving('account', true)
    try {
      await patch('account', { name: accountName })
      markSaved('account')
    } catch (e) { showToast(e instanceof Error ? e.message : 'Could not save account details. Please try again.', 'error') }
    finally { markSaving('account', false) }
  }

  async function handlePasswordReset() {
    if (!accountEmail) return
    try {
      await sendPasswordResetEmail(auth, accountEmail)
      setResetSent(true)
      setTimeout(() => setResetSent(false), 5000)
    } catch (e) { showToast(e instanceof Error ? e.message : 'Could not send the password reset email. Please try again.', 'error') }
  }

  async function handleDeleteAccount() {
    if (deleteConfirm !== 'DELETE') return
    setDeleting(true)
    try {
      const token = await userRef.current?.getIdToken()
      if (!token) return
      await fetch('/api/organizer/settings', {
        method:  'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      await auth.signOut()
    } catch (e) { showToast(e instanceof Error ? e.message : 'Could not delete your account. Please try again.', 'error') }
    finally { setDeleting(false) }
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
        <AlertCircle className="size-4 shrink-0" /> {loadError}
      </div>
    )
  }

  return (
    <div className="space-y-6 pb-10">

      {/* ── Page header ── */}
      <div>
        <h1 className="text-[22px] font-bold text-foreground">Settings</h1>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          Manage your organization profile, branding, and preferences.
        </p>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════
          1. Organization Profile
      ═══════════════════════════════════════════════════════════════════════ */}
      <Section
        icon={Building2}
        title="Organization Profile"
        description="Shown on your event pages, tickets, certificates, and emails"
      >
        <ImageUpload
          label="Organization Logo"
          hint="PNG, JPEG, or SVG. Recommended: 512×512px or larger."
          preview={logoPreview}
          onFile={(file, preview) => { setLogoFile(file); setLogoPreview(preview) }}
          onClear={() => { setLogoFile(null); setLogoPreview(null); setLogoUrl(null) }}
          cropConfig={CROP_LOGO}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput
            label="Organization Name"
            value={orgName}
            onChange={setOrgName}
            placeholder="e.g. Acme Events"
          />
          <TextInput
            label="Website"
            value={orgWebsite}
            onChange={setOrgWebsite}
            type="url"
            placeholder="https://yourorg.com"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput
            label="Support Email"
            value={orgSupportEmail}
            onChange={setOrgSupportEmail}
            type="email"
            placeholder="support@yourorg.com"
            hint="Attendees will contact you at this address."
          />
          <TextInput
            label="Support Phone"
            value={orgSupportPhone}
            onChange={setOrgSupportPhone}
            type="tel"
            placeholder="+91 98765 43210"
          />
        </div>

        <SaveRow
          onSave={saveOrganization}
          saving={!!saving.org}
          saved={!!saved.org}
          label="Save Organization Profile"
        />
      </Section>

      {/* ═══════════════════════════════════════════════════════════════════════
          2. Branding
      ═══════════════════════════════════════════════════════════════════════ */}
      <Section
        icon={Palette}
        title="Branding"
        description="Customize how your organization appears across tickets, certificates, and emails"
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-5">
            <ImageUpload
              label="Certificate Signature"
              hint="Appears at the bottom of certificates. PNG with transparent background recommended."
              preview={certSigPreview}
              onFile={(file, preview) => { setCertSigFile(file); setCertSigPreview(preview) }}
              onClear={() => { setCertSigFile(null); setCertSigPreview(null); setCertSigUrl(null) }}
              cropConfig={CROP_CERT_SIG}
            />

            <ImageUpload
              label="Email Header Image"
              hint="Shown at the top of confirmation and certificate emails. Recommended: 600×120px."
              preview={emailHdrPreview}
              shape="wide"
              onFile={(file, preview) => { setEmailHdrFile(file); setEmailHdrPreview(preview) }}
              onClear={() => { setEmailHdrFile(null); setEmailHdrPreview(null); setEmailHdrUrl(null) }}
              cropConfig={CROP_EMAIL_HDR}
            />

            <ColorPicker
              label="Primary Brand Color"
              value={primaryColor}
              onChange={setPrimaryColor}
              hint="Used for accents on tickets, certificates, and email buttons."
            />
          </div>

          <BrandingPreview
            orgName={orgName}
            logoPreview={logoPreview}
            color={primaryColor}
          />
        </div>

        <SaveRow
          onSave={saveBranding}
          saving={!!saving.brand}
          saved={!!saved.brand}
          label="Save Branding"
        />
      </Section>

      {/* ═══════════════════════════════════════════════════════════════════════
          3. Event Defaults
      ═══════════════════════════════════════════════════════════════════════ */}
      <Section
        icon={CalendarDays}
        title="Event Defaults"
        description="Pre-fill these values when you create a new event — change them any time"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectInput
            label="Default Timezone"
            value={timezone}
            onChange={setTimezone}
            options={TIMEZONES}
          />
          <SelectInput
            label="Default Currency"
            value={currency}
            onChange={setCurrency}
            options={CURRENCIES}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <SelectInput
            label="Registration Closes"
            value={regClose}
            onChange={setRegClose}
            options={REG_CLOSE_RULES}
            hint="When attendees can no longer register."
          />
          <SelectInput
            label="Default Visibility"
            value={visibility}
            onChange={setVisibility}
            options={VISIBILITY_OPTIONS}
          />
        </div>

        <SaveRow
          onSave={saveDefaults}
          saving={!!saving.defaults}
          saved={!!saved.defaults}
          label="Save Defaults"
        />
      </Section>

      {/* ═══════════════════════════════════════════════════════════════════════
          4. Communications
      ═══════════════════════════════════════════════════════════════════════ */}
      <Section
        icon={Bell}
        title="Communications"
        description="Choose which automated emails are sent to your attendees"
      >
        <div className="divide-y divide-border">
          <div className="pb-3">
            <Toggle
              label="Registration Confirmations"
              description="Send a confirmation email when an attendee registers."
              checked={commReg}
              onChange={setCommReg}
            />
          </div>
          <div className="py-3">
            <Toggle
              label="Event Updates"
              description="Notify attendees when you change the date, venue, or key details."
              checked={commUpd}
              onChange={setCommUpd}
            />
          </div>
          <div className="py-3">
            <Toggle
              label="Event Cancellation Notices"
              description="Alert attendees if you cancel an event."
              checked={commCan}
              onChange={setCommCan}
            />
          </div>
          <div className="pt-3">
            <Toggle
              label="Certificate Delivery"
              description="Email certificates to eligible attendees after the event."
              checked={commCert}
              onChange={setCommCert}
            />
          </div>
        </div>

        <SaveRow
          onSave={saveCommunications}
          saving={!!saving.comms}
          saved={!!saved.comms}
          label="Save Preferences"
        />
      </Section>

      {/* ═══════════════════════════════════════════════════════════════════════
          5. Account
      ═══════════════════════════════════════════════════════════════════════ */}
      <Section
        icon={ShieldCheck}
        title="Branding & Domains"
        description="White-label your emails and pages, and connect a custom domain"
      >
        <a
          href="/dashboard/settings/branding"
          className="flex items-center justify-between rounded-xl border border-border bg-muted/30 px-4 py-3.5 transition-colors hover:bg-muted/60"
        >
          <div>
            <p className="text-[14px] font-medium text-foreground">Manage branding & domains</p>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              Logo, colors, sender name, white-label, and custom domain.
            </p>
          </div>
          <span className="text-[13px] font-semibold text-primary">Open →</span>
        </a>
      </Section>

      <Section
        icon={ShieldCheck}
        title="Integrations"
        description="API keys and webhooks for external systems"
      >
        <a
          href="/dashboard/settings/integrations"
          className="flex items-center justify-between rounded-xl border border-border bg-muted/30 px-4 py-3.5 transition-colors hover:bg-muted/60"
        >
          <div>
            <p className="text-[14px] font-medium text-foreground">Manage integrations</p>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              Generate API keys and configure webhook delivery.
            </p>
          </div>
          <span className="text-[13px] font-semibold text-primary">Open →</span>
        </a>
      </Section>

      <Section
        icon={ShieldCheck}
        title="Billing"
        description="View your plan, included limits, and features"
      >
        <a
          href="/dashboard/settings/billing"
          className="flex items-center justify-between rounded-xl border border-border bg-muted/30 px-4 py-3.5 transition-colors hover:bg-muted/60"
        >
          <div>
            <p className="text-[14px] font-medium text-foreground">Manage billing</p>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              See your current plan, usage limits, and upgrade options.
            </p>
          </div>
          <span className="text-[13px] font-semibold text-primary">Open →</span>
        </a>
      </Section>

      <Section
        icon={ShieldCheck}
        title="Team"
        description="Invite team members and assign role-based permissions"
      >
        <a
          href="/dashboard/settings/team"
          className="flex items-center justify-between rounded-xl border border-border bg-muted/30 px-4 py-3.5 transition-colors hover:bg-muted/60"
        >
          <div>
            <p className="text-[14px] font-medium text-foreground">Manage team</p>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              Add admins, managers, check-in staff, and finance users.
            </p>
          </div>
          <span className="text-[13px] font-semibold text-primary">Open →</span>
        </a>
      </Section>

      <Section
        icon={UserIcon}
        title="Account"
        description="Your personal account details"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput
            label="Full Name"
            value={accountName}
            onChange={setAccountName}
            placeholder="Your name"
          />
          <TextInput
            label="Email Address"
            value={accountEmail}
            disabled
            hint="Email cannot be changed here."
          />
        </div>

        <SaveRow
          onSave={saveAccount}
          saving={!!saving.account}
          saved={!!saved.account}
          label="Update Name"
        />

        {/* ── Password ── */}
        <div className="rounded-xl border border-border bg-muted/30 px-4 py-3.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[13px] font-semibold text-foreground">Password</p>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                We will send a reset link to <span className="font-medium">{accountEmail}</span>.
              </p>
            </div>
            <button
              type="button"
              onClick={handlePasswordReset}
              disabled={resetSent}
              className="shrink-0 rounded-lg border border-border bg-card px-4 py-2 text-[14px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
            >
              {resetSent ? '✓ Reset link sent' : 'Send reset link'}
            </button>
          </div>
        </div>

        {/* ── Session Info ── */}
        <div className="rounded-xl border border-border bg-muted/20 px-4 py-4">
          <div className="flex items-center gap-2 mb-3">
            <ShieldCheck className="size-4 text-primary shrink-0" aria-hidden />
            <p className="text-[13px] font-semibold text-foreground">Session Information</p>
          </div>
          <dl className="space-y-2.5">
            <div className="flex items-start justify-between gap-4">
              <dt className="text-[12px] text-muted-foreground">Last Login</dt>
              <dd className="text-[12px] font-medium text-foreground text-right">
                {lastLogin || '—'}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-4">
              <dt className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                <Globe className="size-3 shrink-0" aria-hidden />
                Current Browser
              </dt>
              <dd className="text-[12px] font-medium text-foreground text-right">
                {currentBrowser || '—'}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-4">
              <dt className="text-[12px] text-muted-foreground">Session Status</dt>
              <dd className="flex items-center gap-1.5">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
                <span className="text-[12px] font-medium text-emerald-600">Active</span>
              </dd>
            </div>
          </dl>

          <div className="mt-4 border-t border-border pt-3.5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[14px] font-medium text-foreground">Log Out</p>
                <p className="mt-0.5 text-[13px] text-muted-foreground">
                  Signs you out of this browser and clears your session.
                </p>
              </div>
              <button
                type="button"
                onClick={() => { void auth.signOut() }}
                className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-4 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-muted"
              >
                <LogOut className="size-3.5 shrink-0" aria-hidden />
                Log Out
              </button>
            </div>
          </div>
        </div>

        {/* ── Account Health ── */}
        <AccountHealthPanel
          emailVerified={emailVerified}
          orgName={orgName}
          logoUrl={logoUrl}
          orgWebsite={orgWebsite}
          orgSupportEmail={orgSupportEmail}
        />

        {/* ── Danger zone ── */}
        <div className="rounded-xl border border-destructive/30 bg-destructive/[0.04] px-4 py-4">
          <p className="text-[14px] font-semibold text-destructive">Delete Account</p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Permanently removes your account and all associated data. This cannot be undone.
          </p>

          {!showDeleteZone ? (
            <button
              type="button"
              onClick={() => setShowDeleteZone(true)}
              className="mt-3 rounded-lg border border-destructive/40 px-4 py-2 text-[14px] font-semibold text-destructive transition-colors hover:bg-destructive/[0.07]"
            >
              Delete my account
            </button>
          ) : (
            <div className="mt-3 space-y-3">
              <p className="text-[12px] text-muted-foreground">
                Type{' '}
                <span className="rounded bg-muted px-1 py-0.5 font-mono font-semibold text-foreground">
                  DELETE
                </span>{' '}
                to confirm.
              </p>
              <input
                value={deleteConfirm}
                onChange={e => setDeleteConfirm(e.target.value)}
                className="h-9 w-full rounded-lg border border-destructive/40 bg-card px-3 text-[13px] focus:outline-none focus:ring-2 focus:ring-destructive/25"
                placeholder="DELETE"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={deleteConfirm !== 'DELETE' || deleting}
                  onClick={handleDeleteAccount}
                  className="flex items-center gap-1.5 rounded-lg bg-destructive px-4 py-2 text-[14px] font-semibold text-white disabled:opacity-50"
                >
                  {deleting && <Loader2 className="size-3.5 animate-spin" />}
                  Permanently delete
                </button>
                <button
                  type="button"
                  onClick={() => { setShowDeleteZone(false); setDeleteConfirm('') }}
                  className="rounded-lg border border-border px-4 py-2 text-[13px] font-medium text-muted-foreground hover:bg-muted"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </Section>

    </div>
  )
}
