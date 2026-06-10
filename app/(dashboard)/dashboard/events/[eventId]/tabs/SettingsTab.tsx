'use client'

import { useState } from 'react'
import { cn }       from '@/lib/utils/cn'
import {
  Lock, Pencil, Check, X, Loader2, Plus, Trash2,
} from 'lucide-react'
import type { EventDetailResponse, SpeakerDetail, SponsorDetail } from '@/app/api/organizer/events/[eventId]/route'
import type { EventEditPayload } from '@/types/events'

// ─── Shared display components ────────────────────────────────────────────────

function Section({
  title, locked, lockedMsg, children,
}: {
  title: string; locked?: boolean; lockedMsg?: string; children: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <p className="text-[15px] font-semibold text-foreground">{title}</p>
        {locked && (
          <span className="flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 text-[12px] font-semibold text-amber-700">
            <Lock className="size-3" aria-hidden />{lockedMsg ?? 'Locked'}
          </span>
        )}
      </div>
      <div className="divide-y divide-border">{children}</div>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-start gap-4 px-4 py-3">
      <span className="w-36 shrink-0 text-[13px] text-muted-foreground">{label}</span>
      <span className={cn('flex-1 break-words text-[14px]', value ? 'text-foreground' : 'italic text-muted-foreground/60')}>
        {value ?? 'Not set'}
      </span>
    </div>
  )
}

function FieldList({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="flex items-start gap-4 px-4 py-3">
      <span className="w-36 shrink-0 text-[13px] text-muted-foreground">{label}</span>
      <span className="flex-1 text-[14px] text-foreground">
        {items.length ? items.join(', ') : <span className="italic text-muted-foreground/60">None</span>}
      </span>
    </div>
  )
}

// ─── Input helpers ────────────────────────────────────────────────────────────

function Input({
  label, value, onChange, multiline, disabled, type = 'text',
}: {
  label: string; value: string; onChange: (v: string) => void
  multiline?: boolean; disabled?: boolean; type?: string
}) {
  const cls = cn(
    'w-full rounded-xl border border-border bg-background px-3 py-2 text-[14px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50',
  )
  return (
    <div>
      <label className="mb-1 block text-[13px] text-muted-foreground">{label}</label>
      {multiline ? (
        <textarea value={value} onChange={e => onChange(e.target.value)} disabled={disabled}
          rows={3} className={cn(cls, 'resize-none')} />
      ) : (
        <input type={type} value={value} onChange={e => onChange(e.target.value)}
          disabled={disabled} className={cls} />
      )}
    </div>
  )
}

function Select({
  label, value, onChange, options, disabled,
}: {
  label: string; value: string; onChange: (v: string) => void
  options: { value: string; label: string }[]; disabled?: boolean
}) {
  return (
    <div>
      <label className="mb-1 block text-[13px] text-muted-foreground">{label}</label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        className="w-full rounded-xl border border-border bg-background px-3 py-2 text-[14px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )
}

// ─── Pass Capacity Row ────────────────────────────────────────────────────────

function PassCapacityRow({
  pass, newCapacity, sold, onChange,
}: {
  pass: EventDetailResponse['passes'][number]
  newCapacity: number | null; sold: number
  onChange: (v: number | null) => void
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="flex-1">
        <p className="text-[14px] font-medium text-foreground">{pass.name}</p>
        <p className="text-[13px] text-muted-foreground">{sold} sold</p>
      </div>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <input type="checkbox" checked={newCapacity === null}
            onChange={e => onChange(e.target.checked ? null : (pass.capacity ?? 0))}
            className="rounded" />
          Unlimited
        </label>
        {newCapacity !== null && (
          <input type="number" min={sold} value={newCapacity}
            onChange={e => onChange(Number(e.target.value))}
            className="w-24 rounded-lg border border-border bg-background px-2 py-1 text-[14px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30" />
        )}
      </div>
    </div>
  )
}

// ─── Speaker / Sponsor editors ────────────────────────────────────────────────

function SpeakerRow({
  spk, onChange, onRemove, disabled,
}: {
  spk: SpeakerDetail
  onChange: (updated: SpeakerDetail) => void
  onRemove: () => void
  disabled?: boolean
}) {
  function upd(field: keyof SpeakerDetail, val: string) {
    onChange({ ...spk, [field]: val })
  }
  return (
    <div className="space-y-2 rounded-xl border border-border bg-muted/[0.03] p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Input label="Name *"    value={spk.name}    onChange={v => upd('name', v)}    disabled={disabled} />
        <Input label="Title"     value={spk.title}   onChange={v => upd('title', v)}   disabled={disabled} />
        <Input label="Company"   value={spk.company} onChange={v => upd('company', v)} disabled={disabled} />
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Input label="Photo URL" value={spk.photoUrl} onChange={v => upd('photoUrl', v)} disabled={disabled} />
        <Input label="Bio"       value={spk.bio}      onChange={v => upd('bio', v)}      disabled={disabled} multiline />
      </div>
      <button type="button" onClick={onRemove} disabled={disabled}
        className="flex items-center gap-1 text-[13px] text-red-500 hover:text-red-600 disabled:opacity-40">
        <Trash2 className="size-3" aria-hidden /> Remove speaker
      </button>
    </div>
  )
}

function SponsorRow({
  spo, onChange, onRemove, disabled,
}: {
  spo: SponsorDetail
  onChange: (updated: SponsorDetail) => void
  onRemove: () => void
  disabled?: boolean
}) {
  const TIERS = ['title','gold','silver','bronze','partner','media'].map(t => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) }))
  function upd(field: keyof SponsorDetail, val: string) {
    onChange({ ...spo, [field]: val })
  }
  return (
    <div className="space-y-2 rounded-xl border border-border bg-muted/[0.03] p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Input label="Name *"    value={spo.name}    onChange={v => upd('name', v)}    disabled={disabled} />
        <Select label="Tier"     value={spo.tier}    onChange={v => upd('tier', v)}    options={TIERS} disabled={disabled} />
        <Input label="Website"   value={spo.website} onChange={v => upd('website', v)} disabled={disabled} />
        <Input label="Logo URL"  value={spo.logoUrl} onChange={v => upd('logoUrl', v)} disabled={disabled} />
      </div>
      <button type="button" onClick={onRemove} disabled={disabled}
        className="flex items-center gap-1 text-[13px] text-red-500 hover:text-red-600 disabled:opacity-40">
        <Trash2 className="size-3" aria-hidden /> Remove sponsor
      </button>
    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

interface SettingsTabProps {
  event:     EventDetailResponse
  eventId:   string
  token:     string
  onSuccess: () => void
}

export default function SettingsTab({ event, eventId, token, onSuccess }: SettingsTabProps) {
  const hasRegistrations = event.totalRegistrations > 0
  const isEditable = event.lifecycleStatus !== 'archived' && event.lifecycleStatus !== 'completed'

  // ── Status flags ────────────────────────────────────────────────────────────
  const [editing,   setEditing]   = useState(false)
  const [saving,    setSaving]    = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveOk,    setSaveOk]    = useState(false)

  // ── Basic info ──────────────────────────────────────────────────────────────
  const [name,      setName]      = useState(event.name)
  const [tagline,   setTagline]   = useState(event.tagline    ?? '')
  const [shortDesc, setShortDesc] = useState(event.shortDesc  ?? '')
  const [fullDesc,  setFullDesc]  = useState(event.fullDesc   ?? '')
  const [bannerUrl, setBannerUrl] = useState(event.bannerUrl  ?? '')
  const [logoUrl,   setLogoUrl]   = useState(event.logoUrl    ?? '')

  // ── Schedule ────────────────────────────────────────────────────────────────
  const [startDate, setStartDate] = useState(event.startDate ?? '')
  const [startTime, setStartTime] = useState(event.startTime ?? '')
  const [endDate,   setEndDate]   = useState(event.endDate   ?? '')
  const [endTime,   setEndTime]   = useState(event.endTime   ?? '')
  const [timezone,  setTimezone]  = useState(event.timezone  ?? '')

  // ── Venue ────────────────────────────────────────────────────────────────────
  const [venueType,       setVenueType]       = useState(event.venueType       ?? 'physical')
  const [venueName,       setVenueName]       = useState(event.venueName       ?? '')
  const [venueCity,       setVenueCity]       = useState(event.venueCity       ?? '')
  const [venueAddress,    setVenueAddress]    = useState(event.venueAddress    ?? '')
  const [onlinePlatform,  setOnlinePlatform]  = useState(event.onlinePlatform  ?? '')
  const [onlineMeetingUrl, setOnlineMeetingUrl] = useState(event.onlineMeetingUrl ?? '')

  // ── Organizer ────────────────────────────────────────────────────────────────
  const [orgName,    setOrgName]    = useState(event.organizerName    ?? '')
  const [orgEmail,   setOrgEmail]   = useState(event.organizerEmail   ?? '')
  const [orgPhone,   setOrgPhone]   = useState(event.organizerPhone   ?? '')
  const [orgWebsite, setOrgWebsite] = useState(event.organizerWebsite ?? '')

  // ── Speakers / sponsors / gallery ────────────────────────────────────────────
  const [speakers, setSpeakers] = useState<SpeakerDetail[]>(() => event.speakers)
  const [sponsors, setSponsors] = useState<SponsorDetail[]>(() => event.sponsors)
  const [gallery,  setGallery]  = useState<string[]>(() => event.galleryImages)

  // ── SEO ──────────────────────────────────────────────────────────────────────
  const [metaTitle,       setMetaTitle]       = useState(event.metaTitle       ?? '')
  const [metaDescription, setMetaDescription] = useState(event.metaDescription ?? '')
  const [keywords,        setKeywords]        = useState((event.keywords ?? []).join(', '))

  // ── Pass capacity ────────────────────────────────────────────────────────────
  const [capEdits, setCapEdits] = useState<Record<string, number | null>>(() =>
    Object.fromEntries(event.passes.map(p => [p.id, p.unlimited ? null : p.capacity])),
  )

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function addSpeaker() {
    setSpeakers(prev => [...prev, {
      id: `spk_${Date.now()}`, name: '', title: '', company: '',
      bio: '', photoUrl: '', order: prev.length,
    }])
  }

  function addSponsor() {
    setSponsors(prev => [...prev, {
      id: `spo_${Date.now()}`, name: '', logoUrl: '',
      website: '', tier: 'bronze', order: prev.length,
    }])
  }

  function cancelEdit() {
    setName(event.name); setTagline(event.tagline ?? ''); setShortDesc(event.shortDesc ?? '')
    setFullDesc(event.fullDesc ?? ''); setBannerUrl(event.bannerUrl ?? ''); setLogoUrl(event.logoUrl ?? '')
    setStartDate(event.startDate ?? ''); setStartTime(event.startTime ?? '')
    setEndDate(event.endDate ?? ''); setEndTime(event.endTime ?? ''); setTimezone(event.timezone ?? '')
    setVenueType(event.venueType ?? 'physical'); setVenueName(event.venueName ?? '')
    setVenueCity(event.venueCity ?? ''); setVenueAddress(event.venueAddress ?? '')
    setOnlinePlatform(event.onlinePlatform ?? ''); setOnlineMeetingUrl(event.onlineMeetingUrl ?? '')
    setOrgName(event.organizerName ?? ''); setOrgEmail(event.organizerEmail ?? '')
    setOrgPhone(event.organizerPhone ?? ''); setOrgWebsite(event.organizerWebsite ?? '')
    setSpeakers(event.speakers); setSponsors(event.sponsors); setGallery(event.galleryImages)
    setMetaTitle(event.metaTitle ?? ''); setMetaDescription(event.metaDescription ?? '')
    setKeywords((event.keywords ?? []).join(', '))
    setCapEdits(Object.fromEntries(event.passes.map(p => [p.id, p.unlimited ? null : p.capacity])))
    setSaveError(null); setEditing(false)
  }

  async function handleSave() {
    setSaving(true); setSaveError(null)

    const payload: EventEditPayload = {}

    // Basic info
    if (name.trim()      !== event.name)                  payload.name       = name.trim()
    if (tagline.trim()   !== (event.tagline    ?? ''))    payload.tagline    = tagline.trim()
    if (shortDesc.trim() !== (event.shortDesc  ?? ''))    payload.shortDesc  = shortDesc.trim()
    if (fullDesc.trim()  !== (event.fullDesc   ?? ''))    payload.fullDesc   = fullDesc.trim()
    if (bannerUrl.trim() !== (event.bannerUrl  ?? ''))    payload.bannerUrl  = bannerUrl.trim()
    if (logoUrl.trim()   !== (event.logoUrl    ?? ''))    payload.logoUrl    = logoUrl.trim()

    // Schedule
    if (startDate.trim() !== (event.startDate ?? ''))    payload.startDate  = startDate.trim()
    if (startTime.trim() !== (event.startTime ?? ''))    payload.startTime  = startTime.trim()
    if (endDate.trim()   !== (event.endDate   ?? ''))    payload.endDate    = endDate.trim()
    if (endTime.trim()   !== (event.endTime   ?? ''))    payload.endTime    = endTime.trim()
    if (timezone.trim()  !== (event.timezone  ?? ''))    payload.timezone   = timezone.trim()

    // Venue
    if (venueType        !== (event.venueType        ?? '')) payload.venueType       = venueType
    if (venueName.trim() !== (event.venueName        ?? '')) payload.venueName       = venueName.trim()
    if (venueCity.trim() !== (event.venueCity        ?? '')) payload.venueCity       = venueCity.trim()
    if (venueAddress.trim() !== (event.venueAddress  ?? '')) payload.venueAddress    = venueAddress.trim()
    if (onlinePlatform   !== (event.onlinePlatform   ?? '')) payload.onlinePlatform  = onlinePlatform
    if (onlineMeetingUrl.trim() !== (event.onlineMeetingUrl ?? '')) payload.onlineMeetingUrl = onlineMeetingUrl.trim()

    // Organizer
    if (orgName.trim()    !== (event.organizerName    ?? '')) payload.organizerName    = orgName.trim()
    if (orgEmail.trim()   !== (event.organizerEmail   ?? '')) payload.organizerEmail   = orgEmail.trim()
    if (orgPhone.trim()   !== (event.organizerPhone   ?? '')) payload.organizerPhone   = orgPhone.trim()
    if (orgWebsite.trim() !== (event.organizerWebsite ?? '')) payload.organizerWebsite = orgWebsite.trim()

    // Speakers / sponsors / gallery (deep compare)
    if (JSON.stringify(speakers) !== JSON.stringify(event.speakers))       payload.speakers      = speakers
    if (JSON.stringify(sponsors) !== JSON.stringify(event.sponsors))       payload.sponsors      = sponsors
    if (JSON.stringify(gallery)  !== JSON.stringify(event.galleryImages))  payload.galleryImages = gallery

    // SEO
    const kwArr = keywords.split(',').map(k => k.trim()).filter(Boolean)
    if (metaTitle.trim()       !== (event.metaTitle       ?? '')) payload.metaTitle       = metaTitle.trim()
    if (metaDescription.trim() !== (event.metaDescription ?? '')) payload.metaDescription = metaDescription.trim()
    if (JSON.stringify(kwArr)  !== JSON.stringify(event.keywords ?? []))  payload.keywords = kwArr

    // Pass capacities
    const capChanges = event.passes
      .filter(p => capEdits[p.id] !== (p.unlimited ? null : p.capacity))
      .map(p => ({ passId: p.id, newCapacity: capEdits[p.id] ?? null }))
    if (capChanges.length > 0) payload.passCapacityUpdates = capChanges

    if (Object.keys(payload).length === 0) { setEditing(false); setSaving(false); return }

    const res  = await fetch(`/api/organizer/events/${eventId}/edit`, {
      method:  'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    }).catch(() => null)

    setSaving(false)

    if (!res) { setSaveError('Network error. Please try again.'); return }

    const json = await res.json() as { success: boolean; error?: string }
    if (json.success) {
      setSaveOk(true); setTimeout(() => setSaveOk(false), 2500)
      setEditing(false); onSuccess()
    } else {
      setSaveError(json.error ?? 'Failed to save changes')
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  const VENUE_TYPE_OPTIONS = [
    { value: 'physical', label: 'Physical' },
    { value: 'online',   label: 'Online'   },
    { value: 'hybrid',   label: 'Hybrid'   },
  ]

  const ONLINE_PLATFORM_OPTIONS = [
    { value: '',           label: 'Select platform…' },
    { value: 'zoom',       label: 'Zoom'             },
    { value: 'google_meet', label: 'Google Meet'     },
    { value: 'ms_teams',   label: 'MS Teams'         },
    { value: 'webex',      label: 'Webex'            },
    { value: 'youtube_live', label: 'YouTube Live'   },
    { value: 'custom',     label: 'Custom'           },
  ]

  const isPhysical = venueType === 'physical' || venueType === 'hybrid'
  const isOnline   = venueType === 'online'   || venueType === 'hybrid'

  return (
    <div className="space-y-4">

      {/* Banners */}
      {hasRegistrations && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-[13px] text-amber-800">
          <Lock className="size-4 shrink-0" aria-hidden />
          Event type, visibility, and pass pricing are locked because registrations exist.
        </div>
      )}
      {!isEditable && (
        <div className="flex items-center gap-2 rounded-xl border border-muted bg-muted/30 p-3.5 text-[12.5px] text-muted-foreground">
          <Lock className="size-4 shrink-0" aria-hidden />
          This event is {event.lifecycleStatus} — settings are read-only.
        </div>
      )}
      {saveOk && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3.5 text-[13px] text-emerald-700">
          <Check className="size-4" aria-hidden /> Changes saved successfully.
        </div>
      )}
      {saveError && (
        <p className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-[13px] text-red-600">
          {saveError}
        </p>
      )}

      {/* Edit / Save row */}
      {isEditable && (
        <div className="flex justify-end gap-2">
          {editing ? (
            <>
              <button type="button" onClick={cancelEdit} disabled={saving}
                className="flex items-center gap-1.5 rounded-xl border border-border bg-card px-4 py-2 text-[14px] font-medium hover:bg-muted/60 disabled:opacity-50">
                <X className="size-3.5" aria-hidden /> Cancel
              </button>
              <button type="button" onClick={handleSave} disabled={saving}
                className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-[14px] font-semibold text-white hover:bg-[#bf1868] disabled:opacity-50">
                {saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Check className="size-3.5" aria-hidden />}
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setEditing(true)}
              className="flex items-center gap-1.5 rounded-xl border border-border bg-card px-4 py-2 text-[14px] font-medium hover:bg-muted/60">
              <Pencil className="size-3.5" aria-hidden /> Edit Details
            </button>
          )}
        </div>
      )}

      {/* ── Basic Info ── */}
      {editing ? (
        <div className="rounded-xl border border-border bg-card p-4 space-y-4">
          <p className="text-[15px] font-semibold text-foreground">Basic Info</p>
          <Input label="Event Name *" value={name}      onChange={setName}      disabled={saving} />
          <Input label="Tagline"      value={tagline}   onChange={setTagline}   disabled={saving} />
          <Input label="Short Description" value={shortDesc} onChange={setShortDesc} multiline disabled={saving} />
          <Input label="Full Description"  value={fullDesc}  onChange={setFullDesc}  multiline disabled={saving} />
          <Input label="Banner URL"   value={bannerUrl} onChange={setBannerUrl} disabled={saving} />
          <Input label="Logo URL"     value={logoUrl}   onChange={setLogoUrl}   disabled={saving} />
        </div>
      ) : (
        <Section title="Basic Info">
          <Field label="Event Name"       value={event.name} />
          <Field label="Tagline"          value={event.tagline} />
          <Field label="Short Desc"       value={event.shortDesc} />
          <Field label="Full Desc"        value={event.fullDesc} />
          <Field label="Type"             value={event.eventType} />
          <Field label="Subtype"          value={event.eventSubtype} />
          <Field label="URL Slug"         value={event.slug} />
        </Section>
      )}

      {/* ── Schedule ── */}
      {editing ? (
        <div className="rounded-xl border border-border bg-card p-4 space-y-4">
          <p className="text-[15px] font-semibold text-foreground">
            Schedule
            <span className="ml-2 text-[13px] font-normal text-amber-600">
              Changes here notify attendees (change log created)
            </span>
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Start Date (YYYY-MM-DD)" value={startDate} onChange={setStartDate} disabled={saving} />
            <Input label="Start Time (HH:MM)"      value={startTime} onChange={setStartTime} disabled={saving} />
            <Input label="End Date (YYYY-MM-DD)"   value={endDate}   onChange={setEndDate}   disabled={saving} />
            <Input label="End Time (HH:MM)"        value={endTime}   onChange={setEndTime}   disabled={saving} />
          </div>
          <Input label="Timezone (e.g. Asia/Kolkata)" value={timezone} onChange={setTimezone} disabled={saving} />
        </div>
      ) : (
        <Section title="Schedule">
          <Field label="Start Date"  value={event.startDate} />
          <Field label="Start Time"  value={event.startTime} />
          <Field label="End Date"    value={event.endDate} />
          <Field label="End Time"    value={event.endTime} />
          <Field label="Timezone"    value={event.timezone} />
        </Section>
      )}

      {/* ── Venue ── */}
      {editing ? (
        <div className="rounded-xl border border-border bg-card p-4 space-y-4">
          <p className="text-[15px] font-semibold text-foreground">
            Venue
            <span className="ml-2 text-[13px] font-normal text-amber-600">
              Changes here notify attendees (change log created)
            </span>
          </p>
          <Select label="Venue Type" value={venueType} onChange={setVenueType}
            options={VENUE_TYPE_OPTIONS} disabled={saving} />
          {isPhysical && (
            <div className="grid grid-cols-2 gap-3">
              <Input label="Venue Name *" value={venueName}    onChange={setVenueName}    disabled={saving} />
              <Input label="City *"       value={venueCity}    onChange={setVenueCity}    disabled={saving} />
              <Input label="Address"      value={venueAddress} onChange={setVenueAddress} disabled={saving} />
            </div>
          )}
          {isOnline && (
            <div className="grid grid-cols-2 gap-3">
              <Select label="Platform" value={onlinePlatform} onChange={setOnlinePlatform}
                options={ONLINE_PLATFORM_OPTIONS} disabled={saving} />
              <Input label="Meeting URL" value={onlineMeetingUrl} onChange={setOnlineMeetingUrl} disabled={saving} />
            </div>
          )}
        </div>
      ) : (
        <Section title="Venue">
          <Field label="Venue Type" value={event.venueType} />
          {event.venueType !== 'online' && (
            <>
              <Field label="Venue Name" value={event.venueName} />
              <Field label="City"       value={event.venueCity} />
              <Field label="Address"    value={event.venueAddress} />
            </>
          )}
          {event.venueType !== 'physical' && (
            <>
              <Field label="Platform"    value={event.onlinePlatform} />
              <Field label="Meeting URL" value={event.onlineMeetingUrl} />
            </>
          )}
        </Section>
      )}

      {/* ── Organizer Info ── */}
      {editing ? (
        <div className="rounded-xl border border-border bg-card p-4 space-y-4">
          <p className="text-[15px] font-semibold text-foreground">Organizer Info</p>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Name *"   value={orgName}    onChange={setOrgName}    disabled={saving} />
            <Input label="Email *"  value={orgEmail}   onChange={setOrgEmail}   disabled={saving} type="email" />
            <Input label="Phone"    value={orgPhone}   onChange={setOrgPhone}   disabled={saving} />
            <Input label="Website"  value={orgWebsite} onChange={setOrgWebsite} disabled={saving} />
          </div>
        </div>
      ) : (
        <Section title="Organizer Info">
          <Field label="Name"    value={event.organizerName} />
          <Field label="Email"   value={event.organizerEmail} />
          <Field label="Phone"   value={event.organizerPhone} />
          <Field label="Website" value={event.organizerWebsite} />
        </Section>
      )}

      {/* ── Speakers ── */}
      {editing ? (
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          <p className="text-[15px] font-semibold text-foreground">Speakers</p>
          {speakers.map((spk, i) => (
            <SpeakerRow key={spk.id}
              spk={spk}
              onChange={updated => setSpeakers(prev => prev.map((s, j) => j === i ? updated : s))}
              onRemove={() => setSpeakers(prev => prev.filter((_, j) => j !== i))}
              disabled={saving}
            />
          ))}
          <button type="button" onClick={addSpeaker} disabled={saving}
            className="flex items-center gap-1.5 rounded-xl border border-dashed border-border bg-muted/20 px-3 py-2 text-[13px] font-medium text-muted-foreground hover:bg-muted/40 disabled:opacity-50">
            <Plus className="size-3.5" aria-hidden /> Add Speaker
          </button>
        </div>
      ) : (
        <Section title="Speakers">
          {event.speakers.length === 0 ? (
            <Field label="" value="No speakers added" />
          ) : (
            event.speakers.map(s => (
              <div key={s.id} className="flex items-center gap-3 px-4 py-3">
                {s.photoUrl && <img src={s.photoUrl} alt="" className="size-8 rounded-full object-cover" />}
                <div>
                  <p className="text-[14px] font-medium text-foreground">{s.name || '—'}</p>
                  <p className="text-[13px] text-muted-foreground">
                    {[s.title, s.company].filter(Boolean).join(' · ') || 'No title/company'}
                  </p>
                </div>
              </div>
            ))
          )}
        </Section>
      )}

      {/* ── Sponsors ── */}
      {editing ? (
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          <p className="text-[15px] font-semibold text-foreground">Sponsors</p>
          {sponsors.map((spo, i) => (
            <SponsorRow key={spo.id}
              spo={spo}
              onChange={updated => setSponsors(prev => prev.map((s, j) => j === i ? updated : s))}
              onRemove={() => setSponsors(prev => prev.filter((_, j) => j !== i))}
              disabled={saving}
            />
          ))}
          <button type="button" onClick={addSponsor} disabled={saving}
            className="flex items-center gap-1.5 rounded-xl border border-dashed border-border bg-muted/20 px-3 py-2 text-[13px] font-medium text-muted-foreground hover:bg-muted/40 disabled:opacity-50">
            <Plus className="size-3.5" aria-hidden /> Add Sponsor
          </button>
        </div>
      ) : (
        <Section title="Sponsors">
          {event.sponsors.length === 0 ? (
            <Field label="" value="No sponsors added" />
          ) : (
            event.sponsors.map(s => (
              <div key={s.id} className="flex items-center gap-3 px-4 py-3">
                {s.logoUrl && <img src={s.logoUrl} alt="" className="h-7 max-w-[80px] object-contain" />}
                <div>
                  <p className="text-[14px] font-medium text-foreground">{s.name || '—'}</p>
                  <p className="text-[11.5px] capitalize text-muted-foreground">{s.tier} sponsor</p>
                </div>
              </div>
            ))
          )}
        </Section>
      )}

      {/* ── Gallery ── */}
      {editing ? (
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          <p className="text-[15px] font-semibold text-foreground">Gallery Images</p>
          {gallery.map((url, i) => (
            <div key={i} className="flex gap-2">
              <input
                type="url"
                value={url}
                onChange={e => setGallery(prev => prev.map((u, j) => j === i ? e.target.value : u))}
                placeholder="https://…"
                disabled={saving}
                className="flex-1 rounded-xl border border-border bg-background px-3 py-2 text-[14px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
              />
              <button type="button" onClick={() => setGallery(prev => prev.filter((_, j) => j !== i))}
                disabled={saving}
                className="flex items-center justify-center rounded-xl border border-border px-3 text-muted-foreground hover:text-red-500 disabled:opacity-50">
                <Trash2 className="size-3.5" aria-hidden />
              </button>
            </div>
          ))}
          <button type="button" onClick={() => setGallery(prev => [...prev, ''])} disabled={saving}
            className="flex items-center gap-1.5 rounded-xl border border-dashed border-border bg-muted/20 px-3 py-2 text-[13px] font-medium text-muted-foreground hover:bg-muted/40 disabled:opacity-50">
            <Plus className="size-3.5" aria-hidden /> Add Image
          </button>
        </div>
      ) : (
        <Section title="Gallery">
          {event.galleryImages.length === 0 ? (
            <Field label="" value="No gallery images" />
          ) : (
            <div className="grid grid-cols-3 gap-2 p-4 sm:grid-cols-4">
              {event.galleryImages.map((url, i) => (
                <img key={i} src={url} alt={`Gallery ${i + 1}`}
                  className="aspect-square w-full rounded-lg object-cover" />
              ))}
            </div>
          )}
        </Section>
      )}

      {/* ── SEO ── */}
      {editing ? (
        <div className="rounded-xl border border-border bg-card p-4 space-y-4">
          <p className="text-[15px] font-semibold text-foreground">SEO</p>
          <div className="flex items-center gap-3 rounded-lg bg-muted/30 px-3 py-2">
            <Lock className="size-3.5 text-muted-foreground" aria-hidden />
            <span className="text-[13px] text-muted-foreground">URL slug is locked: <span className="font-mono text-foreground">{event.slug}</span></span>
          </div>
          <Input label="Meta Title"       value={metaTitle}       onChange={setMetaTitle}       disabled={saving} />
          <Input label="Meta Description" value={metaDescription} onChange={setMetaDescription} multiline disabled={saving} />
          <Input label="Keywords (comma-separated)" value={keywords} onChange={setKeywords} disabled={saving} />
        </div>
      ) : (
        <Section title="SEO">
          <Field label="URL Slug"         value={event.slug} />
          <Field label="Meta Title"       value={event.metaTitle} />
          <Field label="Meta Description" value={event.metaDescription} />
          <FieldList label="Keywords"     items={event.keywords} />
        </Section>
      )}

      {/* ── Media preview ── */}
      {!editing && (
        <Section title="Media">
          <div className="space-y-3 px-4 py-3">
            {event.bannerUrl ? (
              <div>
                <p className="mb-1.5 text-[13px] text-muted-foreground">Banner</p>
                <img src={event.bannerUrl} alt="Event banner" className="h-28 w-full rounded-lg object-cover" />
              </div>
            ) : null}
            {event.logoUrl ? (
              <div>
                <p className="mb-1.5 text-[13px] text-muted-foreground">Logo</p>
                <img src={event.logoUrl} alt="Event logo" className="size-16 rounded-lg object-cover" />
              </div>
            ) : null}
            {!event.bannerUrl && !event.logoUrl && (
              <p className="text-[13px] italic text-muted-foreground/60">No media uploaded</p>
            )}
          </div>
        </Section>
      )}

      {/* ── Passes & Pricing ── */}
      <Section title="Passes & Pricing" locked={hasRegistrations} lockedMsg="Pass pricing locked">
        {event.passes.length === 0 ? (
          <Field label="" value="No passes configured" />
        ) : editing ? (
          event.passes.map(p => (
            <PassCapacityRow key={p.id} pass={p} newCapacity={capEdits[p.id] ?? null} sold={p.sold}
              onChange={v => setCapEdits(prev => ({ ...prev, [p.id]: v }))} />
          ))
        ) : (
          event.passes.map(p => (
            <div key={p.id} className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-[14px] font-medium text-foreground">{p.name}</p>
                {p.description && <p className="text-[13px] text-muted-foreground">{p.description}</p>}
              </div>
              <div className="text-right">
                <p className="text-[15px] font-semibold text-foreground">
                  {p.price === 0 ? 'Free' : `₹${(p.price / 100).toLocaleString('en-IN')}`}
                </p>
                <p className="text-[13px] text-muted-foreground">
                  {p.unlimited ? 'Unlimited' : `${p.capacity} seats`}
                </p>
              </div>
            </div>
          ))
        )}
      </Section>

      {/* ── Event Type & Payment — locked ── */}
      <Section title="Event Type & Payment" locked={hasRegistrations} lockedMsg="Locked (registrations exist)">
        <Field label="Payment Model" value={event.isFreeEvent ? 'Free' : 'Paid'} />
        <Field label="Event Type"    value={event.eventType} />
      </Section>
    </div>
  )
}
