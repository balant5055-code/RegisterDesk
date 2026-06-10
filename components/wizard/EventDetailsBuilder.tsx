'use client'

import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Award, Bell, Building2, Calendar, Check, CheckCircle2,
  ChevronDown, ChevronUp, Clock, Eye, FileText, Globe, GripVertical, Hash,
  Info, Link2, ListChecks, Mail, MapPin, Mic, Palette, Pencil, Phone,
  Plus, RefreshCw, Search, Settings2, Share2, Star, Ticket, Trash2,
  Trophy, Upload, Users, Video, X, Zap,
} from 'lucide-react'
import { buttonVariants } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import {
  type EventDetailsDraft, type StatusConfig, type EventInfo, type MediaConfig,
  type VenueConfig, type VenueMaps, type PhysicalVenueConfig,
  type OnlineVenueConfig, type AgendaSession, type EventSchedule,
  type OrganizerInfo, type CommunicationConfig, type ReminderRule,
  type SupportConfig, type SeoConfig, type PublicPageSettings,
  type Speaker, type Sponsor, type ConferenceTrack, type ConferenceDetails,
  type WorkshopDetails, type CulturalDetails, type AwardsDetails,
  type Tab6Config, type CommChannel, type EventStatus,
  makeBlankEventDetailsDraft, makeBlankSession, makeBlankSpeaker,
  makeBlankSponsor, makeTrackId, makeAwardCatId, getEventDays,
  formatDayLabel, fmtTime, slugify, calcStepHealth, getTab6Config,
  makeBlankTypeDetails,
  SESSION_TYPE_LABELS, SPONSOR_TIER_LABELS, ONLINE_PLATFORM_LABELS,
  EVENT_STATUS_LABELS, LANGUAGE_OPTIONS, TIMEZONE_OPTIONS,
} from '@/components/wizard/eventDetailsConfig'
import { BrandingMediaSection } from '@/components/wizard/BrandingMediaSection'
import { ImageAssetInput } from '@/components/wizard/ImageAssetInput'

// ─── Constants ────────────────────────────────────────────────────────────────

const EASE = [0.22, 1, 0.36, 1] as const
const inputCls = 'h-9 w-full rounded-lg border border-border bg-background px-3 text-[12.5px] text-foreground placeholder:text-muted-foreground/60 outline-none transition-colors focus:border-primary/50 focus:ring-2 focus:ring-primary/20'
const labelCls = 'mb-1 block text-[12px] font-medium text-foreground'
const hintCls  = 'mt-1 text-[11px] text-muted-foreground'

// ─── Shared primitives ────────────────────────────────────────────────────────

function SectionCard({ title, children, action }: { title?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between">
          {title && <p className="text-[13px] font-semibold text-foreground">{title}</p>}
          {action}
        </div>
      )}
      {children}
    </div>
  )
}

function Toggle({ checked, onChange, label, desc }: { checked: boolean; onChange: (v: boolean) => void; label: string; desc?: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[12.5px] font-medium text-foreground">{label}</p>
        {desc && <p className="text-[11.5px] leading-snug text-muted-foreground">{desc}</p>}
      </div>
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
        className={cn('relative inline-flex h-[22px] w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200', checked ? 'bg-primary' : 'bg-muted-foreground/30')}>
        <span className={cn('inline-block size-[18px] rounded-full bg-white shadow-sm transition-transform duration-200', checked ? 'translate-x-[18px]' : 'translate-x-0')} />
      </button>
    </div>
  )
}

function ModeCard({ label, desc, selected, onClick, disabled }: { label: string; desc?: string; selected: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" aria-pressed={selected} onClick={onClick} disabled={disabled}
      className={cn('flex flex-col gap-1 rounded-xl border-[1.5px] px-3.5 py-3 text-left transition-all duration-150', selected ? 'border-primary bg-primary/[0.03] shadow-sm' : 'border-border bg-card hover:border-primary/30 hover:bg-muted/[0.03]', disabled && 'cursor-not-allowed opacity-40')}>
      <div className="flex items-center justify-between gap-2">
        <p className={cn('text-[12.5px] font-semibold', selected ? 'text-foreground' : 'text-foreground/80')}>{label}</p>
        <div className={cn('flex size-[16px] shrink-0 items-center justify-center rounded-full border-2', selected ? 'border-primary bg-primary' : 'border-border')}>
          {selected && <div className="size-[8px] rounded-full bg-white" />}
        </div>
      </div>
      {desc && <p className="text-[11.5px] leading-snug text-muted-foreground">{desc}</p>}
    </button>
  )
}

function UrlField({ label, hint, value, onChange, placeholder, required, preview }: {
  label: string; hint?: string; value: string; onChange: (v: string) => void
  placeholder?: string; required?: boolean; preview?: 'square' | 'banner'
}) {
  return (
    <div>
      <label className={labelCls}>{label}{required && <span className="ml-0.5 text-red-500">*</span>}</label>
      {preview && value && (
        <div className={cn('mb-2 overflow-hidden rounded-lg border border-border bg-muted/20', preview === 'banner' ? 'h-24 w-full' : 'h-16 w-16 rounded-full')}>
          <img src={value} alt="" className="h-full w-full object-cover" onError={e => { e.currentTarget.style.display = 'none' }} />
        </div>
      )}
      <input type="url" className={inputCls} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder || 'https://...'} />
      {hint && <p className={hintCls}>{hint}</p>}
    </div>
  )
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

type Tab = 'details' | 'venue' | 'organizer' | 'comms' | 'seo' | 'type'

const BASE_TABS: { id: Tab; label: string; icon: typeof FileText }[] = [
  { id: 'details',   label: 'Details',         icon: FileText  },
  { id: 'venue',     label: 'Venue & Schedule', icon: MapPin    },
  { id: 'organizer', label: 'Organizer',        icon: Users     },
  { id: 'comms',     label: 'Communication',    icon: Bell      },
  { id: 'seo',       label: 'SEO & Discovery',  icon: Globe     },
]

// ─── Tab 1 — Details ─────────────────────────────────────────────────────────

function Tab1Details({ form, update, uploadContext }: { form: EventDetailsDraft; update: (p: Partial<EventDetailsDraft>) => void; uploadContext?: { uid: string; draftId: string } }) {
  const us = (p: Partial<StatusConfig>)      => update({ status:    { ...form.status, ...p } })
  const ui = (p: Partial<EventInfo>)         => update({ info:      { ...form.info, ...p } })
  const um = (p: Partial<MediaConfig>)       => update({ media:     { ...form.media, ...p } })
  const up = (p: Partial<PublicPageSettings>) => update({ publicPage:{ ...form.publicPage, ...p } })

  const STATUS_OPTIONS: { id: EventStatus; desc: string }[] = [
    { id: 'draft',     desc: 'Not visible to the public' },
    { id: 'published', desc: 'Live — registrations open' },
    { id: 'private',   desc: 'Live — access controlled'  },
    { id: 'postponed', desc: 'Visible with postpone notice' },
    { id: 'cancelled', desc: 'Visible with cancellation notice' },
    { id: 'sold_out',  desc: 'Full — waitlist may be active' },
    { id: 'archived',  desc: 'Event ended — read-only record' },
  ]

  const STATUS_COLORS: Record<EventStatus, string> = {
    draft: 'bg-muted text-muted-foreground', published: 'bg-emerald-50 text-emerald-700',
    private: 'bg-blue-50 text-blue-700', postponed: 'bg-amber-50 text-amber-700',
    cancelled: 'bg-rose-50 text-rose-600', sold_out: 'bg-violet-50 text-violet-700',
    archived: 'bg-muted/60 text-muted-foreground/60',
  }

  const THEMES: { id: string; label: string; desc: string }[] = [
    { id: 'default',      label: 'Default',       desc: 'Clean white with primary accent'   },
    { id: 'professional', label: 'Professional',   desc: 'Dark header, serif title, muted'  },
    { id: 'modern',       label: 'Modern',         desc: 'Full-bleed banner, bold type'     },
    { id: 'minimal',      label: 'Minimal',        desc: 'Whitespace-first, text-driven'    },
    { id: 'vibrant',      label: 'Vibrant',        desc: 'Gradient header, high contrast'   },
  ]

  return (
    <div className="flex flex-col gap-3">
      {/* Event Status & Visibility */}
      <SectionCard title="Event Status & Visibility">
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {STATUS_OPTIONS.slice(0, 4).map(opt => (
              <ModeCard key={opt.id} label={EVENT_STATUS_LABELS[opt.id]} desc={opt.desc}
                selected={form.status.status === opt.id} onClick={() => us({ status: opt.id })} />
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {STATUS_OPTIONS.slice(4).map(opt => (
              <ModeCard key={opt.id} label={EVENT_STATUS_LABELS[opt.id]} desc={opt.desc}
                selected={form.status.status === opt.id} onClick={() => us({ status: opt.id })} />
            ))}
          </div>
          <AnimatePresence>
            {form.status.status === 'postponed' && (
              <motion.div key="postpone-fields" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
                <div className="flex flex-col gap-3 rounded-lg border border-amber-200/60 bg-amber-50/40 p-3">
                  <div><label className={labelCls}>New Date (if known)</label><input type="date" className={inputCls} value={form.status.postponedDate} onChange={e => us({ postponedDate: e.target.value })} /></div>
                  <div><label className={labelCls}>Message to Attendees</label><textarea className={cn(inputCls, 'h-20 resize-none py-2')} maxLength={300} value={form.status.postponedMessage} onChange={e => us({ postponedMessage: e.target.value })} placeholder="e.g. Due to unforeseen circumstances, the event has been postponed." /></div>
                </div>
              </motion.div>
            )}
            {form.status.status === 'cancelled' && (
              <motion.div key="cancel-fields" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
                <div className="rounded-lg border border-rose-200/60 bg-rose-50/40 p-3">
                  <label className={labelCls}>Cancellation Message</label>
                  <textarea className={cn(inputCls, 'h-20 resize-none py-2')} maxLength={300} value={form.status.cancellationMessage} onChange={e => us({ cancellationMessage: e.target.value })} placeholder="e.g. We regret to inform you that this event has been cancelled." />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <Toggle checked={form.status.notifyRegistrantsOnStatusChange}
            onChange={v => us({ notifyRegistrantsOnStatusChange: v })}
            label="Notify registered attendees of status change"
            desc="Sends an automated notification to all confirmed registrants" />
          <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/[0.04] px-3 py-2">
            <span className={cn('rounded-full px-2 py-0.5 text-[10.5px] font-semibold', STATUS_COLORS[form.status.status])}>{EVENT_STATUS_LABELS[form.status.status]}</span>
            <p className="text-[11.5px] text-muted-foreground">Visibility is set in Step 2 — change it there if needed.</p>
          </div>
        </div>
      </SectionCard>

      {/* Event Information */}
      <SectionCard title="Event Information">
        <div className="flex flex-col gap-3">
          <div><label className={labelCls}>Event Name <span className="text-red-500">*</span></label><input className={inputCls} maxLength={120} value={form.info.name} onChange={e => ui({ name: e.target.value })} placeholder="e.g. TechFest India 2026" /></div>
          <div><label className={labelCls}>Tagline <span className={hintCls.replace('mt-1 ', '')}>(optional)</span></label><input className={inputCls} maxLength={100} value={form.info.tagline} onChange={e => ui({ tagline: e.target.value })} placeholder="e.g. India's largest developer conference" /></div>
          <div>
            <label className={labelCls}>Short Description <span className={hintCls.replace('mt-1 ', '')}>(shown in search &amp; cards — 300 chars)</span></label>
            <div className="relative"><textarea className={cn(inputCls, 'h-20 resize-none py-2 pr-14')} maxLength={300} value={form.info.shortDesc} onChange={e => ui({ shortDesc: e.target.value })} placeholder="A brief overview of your event…" /><span className="pointer-events-none absolute bottom-2 right-3 text-[10.5px] text-muted-foreground">{form.info.shortDesc.length}/300</span></div>
          </div>
          <div><label className={labelCls}>Full Description <span className={hintCls.replace('mt-1 ', '')}>(shown on event page — markdown supported)</span></label><textarea className={cn(inputCls, 'h-32 resize-none py-2')} value={form.info.fullDesc} onChange={e => ui({ fullDesc: e.target.value })} placeholder="Tell attendees everything about your event…" /></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelCls}>Event Language</label>
              <select className={inputCls} value={form.info.language} onChange={e => ui({ language: e.target.value })}>
                {LANGUAGE_OPTIONS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
            </div>
            <div><label className={labelCls}>Dress Code <span className={hintCls.replace('mt-1 ', '')}>(optional)</span></label><input className={inputCls} value={form.info.dressCode} onChange={e => ui({ dressCode: e.target.value })} placeholder="e.g. Business Formal, Smart Casual" /></div>
          </div>
        </div>
      </SectionCard>

      {/* Branding & Media */}
      <BrandingMediaSection media={form.media} onChange={um} uploadContext={uploadContext} />

      {/* Public Page Settings */}
      <SectionCard title="Public Page Settings" action={<span className="text-[11px] text-muted-foreground">Controls what appears on your event page</span>}>
        <div className="flex flex-col gap-3">
          {([
            ['showOrganizerInfo', 'Show Organizer Information', 'Display organizer name, logo and contact'],
            ['showSpeakers',      'Show Speakers',               'Show speaker profiles on the event page'],
            ['showSponsors',      'Show Sponsors',               'Display sponsor logos and tiers'],
            ['showVenueMap',      'Show Venue Map',              'Embed Google Maps or venue layout'],
            ['showAgenda',        'Show Agenda',                 'Display the session schedule'],
            ['showGallery',       'Show Gallery',                'Show event photo gallery'],
            ['showSocialLinks',   'Show Social Links',           'Display organizer social media links'],
            ['showAttendeeCount', 'Show Attendee Count',         'Show "X people registered" on the page'],
          ] as [keyof PublicPageSettings, string, string][]).map(([key, label, desc]) => (
            <Toggle key={key} checked={form.publicPage[key]} onChange={v => up({ [key]: v })} label={label} desc={desc} />
          ))}
        </div>
      </SectionCard>
    </div>
  )
}

// ─── Tab 2 — Venue & Schedule ─────────────────────────────────────────────────

function Tab2VenueSchedule({
  form, update, onAddSession, onEditSession, onDeleteSession, onMoveSession,
}: {
  form:            EventDetailsDraft
  update:          (p: Partial<EventDetailsDraft>) => void
  onAddSession:    (date: string, order: number) => void
  onEditSession:   (s: AgendaSession) => void
  onDeleteSession: (id: string) => void
  onMoveSession:   (id: string, dir: 'up' | 'down') => void
}) {
  const uv  = (p: Partial<VenueConfig>)         => update({ venue:    { ...form.venue, ...p } })
  const uph = (p: Partial<PhysicalVenueConfig>) => uv({ physical: { ...form.venue.physical, ...p } })
  const uon = (p: Partial<OnlineVenueConfig>)   => uv({ online:   { ...form.venue.online, ...p } })
  const ump = (p: Partial<typeof form.venue.physical.maps>) => uph({ maps: { ...form.venue.physical.maps, ...p } })
  const us  = (p: Partial<EventSchedule>)       => update({ schedule: { ...form.schedule, ...p } })

  const [showPass, setShowPass] = useState(false)
  const [showMaps, setShowMaps] = useState(false)

  const PLATFORMS = Object.entries(ONLINE_PLATFORM_LABELS).map(([id, label]) => ({ id: id as typeof form.venue.online.platform, label }))

  const isPhysical = form.venue.type === 'physical' || form.venue.type === 'hybrid'
  const isOnline   = form.venue.type === 'online'   || form.venue.type === 'hybrid'

  // Compute event days
  const days = getEventDays(form.schedule.startDate, form.schedule.endDate)
  const sessionsByDay = days.map(d => ({
    date:     d,
    sessions: form.schedule.agenda.filter(s => s.date === d || (days.length === 1 && !s.date)).sort((a, b) => a.order - b.order),
  }))
  const allSessions = form.schedule.agenda.length

  // Duration display
  const duration = (() => {
    if (!form.schedule.startDate || !form.schedule.endDate || !form.schedule.startTime || !form.schedule.endTime) return ''
    try {
      const start = new Date(`${form.schedule.startDate}T${form.schedule.startTime}`)
      const end   = new Date(`${form.schedule.endDate}T${form.schedule.endTime}`)
      const mins  = Math.max(0, (end.getTime() - start.getTime()) / 60000)
      const days  = Math.floor(mins / 1440)
      const hrs   = Math.floor((mins % 1440) / 60)
      const parts = []
      if (days > 0) parts.push(`${days} day${days > 1 ? 's' : ''}`)
      if (hrs  > 0) parts.push(`${hrs} hr${hrs > 1 ? 's' : ''}`)
      return parts.join(', ')
    } catch { return '' }
  })()

  return (
    <div className="flex flex-col gap-3">
      {/* Venue */}
      <SectionCard title="Venue & Access">
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {([['physical','Physical',Building2,'In-person venue'],['online','Online',Video,'Virtual / live-stream'],['hybrid','Hybrid',Users,'Both physical & online']] as const).map(([id, label, Icon, desc]) => (
              <ModeCard key={id} label={label} desc={desc} selected={form.venue.type === id} onClick={() => uv({ type: id })} />
            ))}
          </div>
          <AnimatePresence>
            {isPhysical && (
              <motion.div key="physical" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
                <div className="flex flex-col gap-3 rounded-xl border border-border bg-muted/[0.02] p-4">
                  <p className="flex items-center gap-2 text-[12px] font-semibold text-foreground"><Building2 className="size-3.5 shrink-0 text-muted-foreground/50" aria-hidden />Physical Venue</p>
                  <div><label className={labelCls}>Venue Name <span className="text-red-500">*</span></label><input className={inputCls} value={form.venue.physical.name} onChange={e => uph({ name: e.target.value })} placeholder="e.g. NSCI Dome, Mumbai" /></div>
                  <div><label className={labelCls}>Address Line 1</label><input className={inputCls} value={form.venue.physical.addressLine1} onChange={e => uph({ addressLine1: e.target.value })} placeholder="Street / Building name" /></div>
                  <div><label className={labelCls}>Address Line 2</label><input className={inputCls} value={form.venue.physical.addressLine2} onChange={e => uph({ addressLine2: e.target.value })} placeholder="Area / Landmark" /></div>
                  <div className="grid grid-cols-3 gap-2">
                    <div><label className={labelCls}>City</label><input className={inputCls} value={form.venue.physical.city} onChange={e => uph({ city: e.target.value })} placeholder="Mumbai" /></div>
                    <div><label className={labelCls}>State</label><input className={inputCls} value={form.venue.physical.state} onChange={e => uph({ state: e.target.value })} placeholder="Maharashtra" /></div>
                    <div><label className={labelCls}>Pincode</label><input className={inputCls} value={form.venue.physical.pincode} onChange={e => uph({ pincode: e.target.value })} placeholder="400001" /></div>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div><label className={labelCls}>Country</label><input className={inputCls} value={form.venue.physical.country} onChange={e => uph({ country: e.target.value })} placeholder="India" /></div>
                    <div><label className={labelCls}>Google Maps Link</label><input type="url" className={inputCls} value={form.venue.physical.mapsLink} onChange={e => uph({ mapsLink: e.target.value })} placeholder="https://maps.google.com/..." /></div>
                  </div>
                  <div><label className={labelCls}>Getting There / Instructions <span className={hintCls.replace('mt-1 ', '')}>(optional)</span></label><textarea className={cn(inputCls, 'h-16 resize-none py-2')} value={form.venue.physical.instructions} onChange={e => uph({ instructions: e.target.value })} placeholder="Parking, entry gate, nearest metro…" /></div>
                </div>
              </motion.div>
            )}
            {isOnline && (
              <motion.div key="online" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
                <div className="flex flex-col gap-3 rounded-xl border border-border bg-muted/[0.02] p-4">
                  <p className="flex items-center gap-2 text-[12px] font-semibold text-foreground"><Video className="size-3.5 shrink-0 text-muted-foreground/50" aria-hidden />Online Platform</p>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {PLATFORMS.map(p => (
                      <ModeCard key={p.id} label={p.label} selected={form.venue.online.platform === p.id} onClick={() => uon({ platform: p.id })} />
                    ))}
                  </div>
                  {form.venue.online.platform === 'custom' && (
                    <div><label className={labelCls}>Platform Name</label><input className={inputCls} value={form.venue.online.platformCustomName} onChange={e => uon({ platformCustomName: e.target.value })} placeholder="e.g. Hopin, StreamYard" /></div>
                  )}
                  <div>
                    <label className={labelCls}>Meeting URL <span className="text-red-500">*</span></label>
                    <input type="url" className={inputCls} value={form.venue.online.meetingUrl} onChange={e => uon({ meetingUrl: e.target.value })} placeholder="https://zoom.us/j/..." />
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div><label className={labelCls}>Meeting ID <span className={hintCls.replace('mt-1 ', '')}>(optional)</span></label><input className={inputCls} value={form.venue.online.meetingId} onChange={e => uon({ meetingId: e.target.value })} /></div>
                    <div>
                      <label className={labelCls}>Passcode <span className={hintCls.replace('mt-1 ', '')}>(optional)</span></label>
                      <input className={inputCls} type={showPass ? 'text' : 'password'} value={form.venue.online.passcode} onChange={e => uon({ passcode: e.target.value })} />
                      <button type="button" onClick={() => setShowPass(v => !v)} className="mt-1 text-[11px] text-primary hover:underline">{showPass ? 'Hide' : 'Show'} passcode</button>
                    </div>
                  </div>
                  <Toggle checked={form.venue.online.revealAfterRegistration} onChange={v => uon({ revealAfterRegistration: v })} label="Reveal meeting link after registration" desc="Meeting URL is sent only in the confirmation message, not shown publicly" />
                  <div><label className={labelCls}>Join Instructions <span className={hintCls.replace('mt-1 ', '')}>(optional)</span></label><textarea className={cn(inputCls, 'h-16 resize-none py-2')} value={form.venue.online.joinInstructions} onChange={e => uon({ joinInstructions: e.target.value })} placeholder="Steps to join the session…" /></div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          {/* Venue Maps sub-section */}
          {isPhysical && (
            <div className="overflow-hidden rounded-xl border border-border">
              <button type="button" onClick={() => setShowMaps(v => !v)} className="flex w-full items-center justify-between px-4 py-3 transition-colors hover:bg-muted/[0.03]">
                <div className="flex items-center gap-2"><MapPin className="size-3.5 text-muted-foreground/50" aria-hidden /><p className="text-[12.5px] font-medium text-foreground">Venue Maps &amp; Layout <span className="ml-1 text-[11px] font-normal text-muted-foreground">(Optional)</span></p></div>
                <ChevronDown className={cn('size-4 text-muted-foreground transition-transform duration-200', showMaps && 'rotate-180')} aria-hidden />
              </button>
              <AnimatePresence>
                {showMaps && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden border-t border-border">
                    <div className="flex flex-col gap-3 p-4">
                      <div className="flex items-start gap-2 rounded-lg border border-primary/10 bg-primary/[0.04] px-3 py-2"><Info className="mt-0.5 size-3.5 shrink-0 text-primary/70" aria-hidden /><p className="text-[11.5px] text-muted-foreground">Upload map images to help attendees navigate on the day.</p></div>
                      <ImageAssetInput label="Venue / Hall Layout" value={form.venue.physical.maps.layoutImageUrl} onChange={v => ump({ layoutImageUrl: v })} hint="Floor plan or hall layout image — PNG / JPG" />
                      <ImageAssetInput label="Parking Map" value={form.venue.physical.maps.parkingMapUrl} onChange={v => ump({ parkingMapUrl: v })} hint="Parking area map image" />
                      <ImageAssetInput label="Entry Gate Map" value={form.venue.physical.maps.entryGateMapUrl} onChange={v => ump({ entryGateMapUrl: v })} hint="Entry gate or directions map image" />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </div>
      </SectionCard>

      {/* Event Schedule */}
      <SectionCard title="Event Schedule">
        <div className="flex flex-col gap-3">
          <div>
            <label className={labelCls}>Timezone</label>
            <select className={inputCls} value={form.schedule.timezone} onChange={e => us({ timezone: e.target.value })}>
              {TIMEZONE_OPTIONS.map(tz => <option key={tz.id} value={tz.id}>{tz.label}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={labelCls}>Start Date <span className="text-red-500">*</span></label><input type="date" className={inputCls} value={form.schedule.startDate} onChange={e => us({ startDate: e.target.value })} /></div>
            <div><label className={labelCls}>Start Time <span className="text-red-500">*</span></label><input type="time" className={inputCls} value={form.schedule.startTime} onChange={e => us({ startTime: e.target.value })} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={labelCls}>End Date <span className="text-red-500">*</span></label><input type="date" className={inputCls} value={form.schedule.endDate} onChange={e => us({ endDate: e.target.value })} /></div>
            <div><label className={labelCls}>End Time <span className="text-red-500">*</span></label><input type="time" className={inputCls} value={form.schedule.endTime} onChange={e => us({ endTime: e.target.value })} /></div>
          </div>
          {duration && (
            <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/[0.03] px-3 py-2">
              <Clock className="size-3.5 shrink-0 text-muted-foreground/50" aria-hidden />
              <p className="text-[12px] text-muted-foreground">Duration: <span className="font-semibold text-foreground">{duration}</span></p>
            </div>
          )}
          <div><label className={labelCls}>Doors Open Time <span className={hintCls.replace('mt-1 ', '')}>(optional)</span></label><input type="time" className={inputCls} value={form.schedule.doorsOpenTime} onChange={e => us({ doorsOpenTime: e.target.value })} /></div>
        </div>
      </SectionCard>

      {/* Agenda Builder */}
      <SectionCard title="Agenda" action={<span className="text-[11px] text-muted-foreground">{allSessions} session{allSessions !== 1 ? 's' : ''}</span>}>
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-2 rounded-lg border border-primary/10 bg-primary/[0.04] px-3 py-2">
            <Info className="mt-0.5 size-3.5 shrink-0 text-primary/70" aria-hidden />
            <p className="text-[11.5px] text-muted-foreground">Agenda appears on your public event page. Add sessions, breaks and panels.</p>
          </div>
          {days.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <Calendar className="size-8 text-muted-foreground/20" aria-hidden />
              <p className="text-[12.5px] font-semibold text-foreground">Set event dates first</p>
              <p className="text-[12px] text-muted-foreground">Add start and end dates above to build your agenda.</p>
            </div>
          ) : (
            days.map((date, dayIdx) => {
              const daySessions = sessionsByDay[dayIdx]?.sessions ?? []
              return (
                <div key={date} className="overflow-hidden rounded-xl border border-border">
                  {days.length > 1 && (
                    <div className="border-b border-border/70 bg-muted/[0.04] px-4 py-2">
                      <p className="text-[12.5px] font-semibold text-foreground">{formatDayLabel(date, dayIdx)}</p>
                    </div>
                  )}
                  {daySessions.length > 0 && (
                    <div>
                      {daySessions.map((sess, sIdx) => (
                        <div key={sess.id} className="flex items-center gap-2 border-b border-border/30 px-3 py-2 last:border-0 hover:bg-muted/[0.03]">
                          <GripVertical className="size-3 shrink-0 text-muted-foreground/25" aria-hidden />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-[11.5px] font-medium text-foreground">{fmtTime(sess.startTime)}–{fmtTime(sess.endTime)}</span>
                              <span className="rounded-full bg-muted/60 px-1.5 py-px text-[10px] font-medium text-muted-foreground">{SESSION_TYPE_LABELS[sess.type]}</span>
                              <span className="truncate text-[12px] text-foreground">{sess.title || <em className="text-muted-foreground/40">Untitled</em>}</span>
                              {sess.location && <span className="text-[10.5px] text-muted-foreground">· {sess.location}</span>}
                            </div>
                          </div>
                          <div className="flex items-center gap-0.5">
                            <button type="button" disabled={sIdx === 0} onClick={() => onMoveSession(sess.id, 'up')} className="flex size-6 items-center justify-center rounded text-muted-foreground/40 hover:bg-muted/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-20"><ChevronUp className="size-3.5" aria-hidden /></button>
                            <button type="button" disabled={sIdx === daySessions.length - 1} onClick={() => onMoveSession(sess.id, 'down')} className="flex size-6 items-center justify-center rounded text-muted-foreground/40 hover:bg-muted/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-20"><ChevronDown className="size-3.5" aria-hidden /></button>
                            <button type="button" onClick={() => onEditSession(sess)} className="flex size-6 items-center justify-center rounded text-muted-foreground/40 hover:bg-primary/10 hover:text-primary"><Pencil className="size-3" aria-hidden /></button>
                            <button type="button" onClick={() => onDeleteSession(sess.id)} className="flex size-6 items-center justify-center rounded text-muted-foreground/40 hover:bg-red-50 hover:text-red-500"><Trash2 className="size-3" aria-hidden /></button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="px-3 py-2">
                    <button type="button" onClick={() => onAddSession(date, daySessions.length)}
                      className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'w-full gap-1.5 border-dashed border-primary/20 text-[12px] text-primary/70 hover:border-primary/40 hover:bg-primary/[0.02]')}>
                      <Plus className="size-3" aria-hidden />
                      {days.length > 1 ? `Add Session to ${formatDayLabel(date, dayIdx)}` : 'Add Session'}
                    </button>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </SectionCard>
    </div>
  )
}

// ─── Tab 3 — Organizer & Support ──────────────────────────────────────────────

function Tab3Organizer({ form, update }: { form: EventDetailsDraft; update: (p: Partial<EventDetailsDraft>) => void }) {
  const uo = (p: Partial<OrganizerInfo>) => update({ organizer: { ...form.organizer, ...p } })
  const usc = (p: Partial<typeof form.organizer.social>) => uo({ social: { ...form.organizer.social, ...p } })
  const urw = (p: Partial<typeof form.support.refundWindow>) => update({ support: { ...form.support, refundWindow: { ...form.support.refundWindow, ...p } } })
  const usp = (p: Partial<SupportConfig>) => update({ support: { ...form.support, ...p } })

  return (
    <div className="flex flex-col gap-3">
      <SectionCard title="Organizer Information">
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div><label className={labelCls}>Organizer Name <span className="text-red-500">*</span></label><input className={inputCls} value={form.organizer.name} onChange={e => uo({ name: e.target.value })} placeholder="e.g. TechFest Foundation" /></div>
            <div><label className={labelCls}>Organizer Email <span className="text-red-500">*</span></label><input type="email" className={inputCls} value={form.organizer.email} onChange={e => uo({ email: e.target.value })} placeholder="organizer@example.com" /></div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><label className={labelCls}>Phone</label><input type="tel" className={inputCls} value={form.organizer.phone} onChange={e => uo({ phone: e.target.value })} placeholder="+91 9800000000" /></div>
            <div><label className={labelCls}>Website</label><input type="url" className={inputCls} value={form.organizer.website} onChange={e => uo({ website: e.target.value })} placeholder="https://your-org.com" /></div>
          </div>
          <ImageAssetInput label="Organizer Logo" value={form.organizer.logoUrl} onChange={v => uo({ logoUrl: v })} hint="Square PNG / JPG — 300 × 300 px recommended" shape="square" maxDim={600} targetKB={150} />
          <p className={labelCls + ' !mb-0 mt-1'}>Social Media</p>
          <div className="grid grid-cols-2 gap-2">
            {([
              ['facebook',  'Facebook URL',  'https://facebook.com/...'],
              ['instagram', 'Instagram URL', 'https://instagram.com/...'],
              ['linkedin',  'LinkedIn URL',  'https://linkedin.com/company/...'],
              ['youtube',   'YouTube URL',   'https://youtube.com/@...'],
              ['twitter',   'Twitter/X URL', 'https://twitter.com/...'],
            ] as [keyof typeof form.organizer.social, string, string][]).filter(([k]) => k !== 'hashtags').map(([key, label, ph]) => (
              <div key={key}><label className={labelCls}>{label}</label><input type="url" className={inputCls} value={form.organizer.social[key] as string} onChange={e => usc({ [key]: e.target.value })} placeholder={ph} /></div>
            ))}
          </div>
          <div>
            <label className={labelCls}>Event Hashtags <span className={hintCls.replace('mt-1 ', '')}>(comma-separated)</span></label>
            <input className={inputCls} value={form.organizer.social.hashtags.join(', ')} onChange={e => usc({ hashtags: e.target.value.split(',').map(h => h.trim()).filter(Boolean) })} placeholder="TechConf2026, RegisterDesk, Innovation" />
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Contact & Support">
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div><label className={labelCls}>Support Email</label><input type="email" className={inputCls} value={form.support.supportEmail} onChange={e => usp({ supportEmail: e.target.value })} placeholder="support@yourorg.com" /></div>
            <div><label className={labelCls}>Support Phone</label><input type="tel" className={inputCls} value={form.support.supportPhone} onChange={e => usp({ supportPhone: e.target.value })} /></div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><label className={labelCls}>FAQ URL</label><input type="url" className={inputCls} value={form.support.faqUrl} onChange={e => usp({ faqUrl: e.target.value })} /></div>
            <div><label className={labelCls}>Terms &amp; Conditions URL</label><input type="url" className={inputCls} value={form.support.termsUrl} onChange={e => usp({ termsUrl: e.target.value })} /></div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><label className={labelCls}>Refund Policy URL</label><input type="url" className={inputCls} value={form.support.refundPolicyUrl} onChange={e => usp({ refundPolicyUrl: e.target.value })} /></div>
            <div><label className={labelCls}>Privacy Policy URL</label><input type="url" className={inputCls} value={form.support.privacyPolicyUrl} onChange={e => usp({ privacyPolicyUrl: e.target.value })} /></div>
          </div>
          <Toggle checked={!form.support.refundWindow.useExternalPolicyUrl} onChange={v => urw({ useExternalPolicyUrl: !v })} label="Set structured refund window" desc="Define refund rules directly in the platform" />
          <AnimatePresence>
            {!form.support.refundWindow.useExternalPolicyUrl && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
                <div className="grid gap-3 rounded-lg border border-border/60 bg-muted/[0.03] p-3 sm:grid-cols-3">
                  <div><label className={labelCls}>Full refund until</label><div className="flex items-center gap-1"><input type="number" min={0} className={inputCls} value={form.support.refundWindow.fullRefundDaysBefore ?? ''} onChange={e => urw({ fullRefundDaysBefore: e.target.value ? Number(e.target.value) : null })} /><span className="shrink-0 text-[12px] text-muted-foreground">days before</span></div></div>
                  <div><label className={labelCls}>50% refund until</label><div className="flex items-center gap-1"><input type="number" min={0} className={inputCls} value={form.support.refundWindow.partialRefundDaysBefore ?? ''} onChange={e => urw({ partialRefundDaysBefore: e.target.value ? Number(e.target.value) : null })} /><span className="shrink-0 text-[12px] text-muted-foreground">days before</span></div></div>
                  <div><label className={labelCls}>No refund after</label><div className="flex items-center gap-1"><input type="number" min={0} className={inputCls} value={form.support.refundWindow.noRefundDaysBefore ?? ''} onChange={e => urw({ noRefundDaysBefore: e.target.value ? Number(e.target.value) : null })} /><span className="shrink-0 text-[12px] text-muted-foreground">days before</span></div></div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </SectionCard>
    </div>
  )
}

// ─── Tab 4 — Communication ────────────────────────────────────────────────────

function Tab4Communication({ form, update }: { form: EventDetailsDraft; update: (p: Partial<EventDetailsDraft>) => void }) {
  const uc  = (p: Partial<CommunicationConfig>) => update({ communication: { ...form.communication, ...p } })
  const ucf = (p: Partial<typeof form.communication.confirmation>) => uc({ confirmation: { ...form.communication.confirmation, ...p } })
  const [tplTab,  setTplTab]  = useState<'ce'|'cw'|'cs'|'re'|'rw'>('ce')
  const [tplOpen, setTplOpen] = useState(false)

  const CHANNELS: { id: CommChannel; label: string }[] = [
    { id: 'email',    label: 'Email'    },
    { id: 'whatsapp', label: 'WhatsApp' },
    { id: 'sms',      label: 'SMS'      },
  ]

  const toggleChannel = (ch: CommChannel) => {
    const cur = form.communication.confirmation.channels
    ucf({ channels: cur.includes(ch) ? cur.filter(c => c !== ch) : [...cur, ch] })
  }

  const toggleReminderChannel = (ruleId: string, ch: CommChannel) => {
    uc({ reminders: form.communication.reminders.map(r => r.id === ruleId ? {
      ...r, channels: r.channels.includes(ch) ? r.channels.filter(c => c !== ch) : [...r.channels, ch]
    } : r)})
  }

  const REMINDER_LABELS: Record<string, string> = { '7d': '7 Days Before', '3d': '3 Days Before', '1d': '1 Day Before', '2h': '2 Hours Before', custom: 'Custom' }

  const TPL_TABS = [
    { id: 'ce' as const, label: 'Conf. Email' },
    { id: 'cw' as const, label: 'Conf. WhatsApp' },
    { id: 're' as const, label: 'Reminder Email' },
    { id: 'rw' as const, label: 'Reminder WhatsApp' },
  ]

  const tplKey = {
    ce: 'confirmationEmail', cw: 'confirmationWhatsApp', cs: 'confirmationSms', re: 'reminderEmail', rw: 'reminderWhatsApp',
  } as const

  const tpl = form.communication.templates[tplKey[tplTab] as keyof typeof form.communication.templates]

  return (
    <div className="flex flex-col gap-3">
      <SectionCard title="Registration Confirmation">
        <div className="flex flex-col gap-4">
          <div>
            <p className={labelCls}>Notification Channels</p>
            <div className="flex flex-wrap gap-2">
              {CHANNELS.map(ch => {
                const on = form.communication.confirmation.channels.includes(ch.id)
                return (
                  <button key={ch.id} type="button" onClick={() => toggleChannel(ch.id)}
                    className={cn('flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors', on ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-primary/40')}>
                    {on && <Check className="size-3" aria-hidden />}{ch.label}
                  </button>
                )
              })}
            </div>
          </div>
          <Toggle checked={form.communication.confirmation.calendarInvite}   onChange={v => ucf({ calendarInvite: v })}   label="Send Calendar Invite (.ics)" desc="Attached to the confirmation email for easy calendar add" />
          <Toggle checked={form.communication.confirmation.generateQrTicket} onChange={v => ucf({ generateQrTicket: v })} label="Generate QR E-Ticket" desc="A unique QR code per registration included in confirmation" />
        </div>
      </SectionCard>

      <SectionCard title="Reminder Schedule">
        <div className="flex flex-col gap-2">
          {form.communication.reminders.map(rule => (
            <div key={rule.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-border/60 bg-muted/[0.03] px-3 py-2.5">
              <Toggle checked={rule.enabled} onChange={v => uc({ reminders: form.communication.reminders.map(r => r.id === rule.id ? { ...r, enabled: v } : r) })} label={rule.timing === 'custom' ? `${rule.customHours ?? '?'}h Before` : REMINDER_LABELS[rule.timing] ?? rule.timing} />
              {rule.timing === 'custom' && (
                <input type="number" min={1} className={cn(inputCls, 'h-7 w-20')} value={rule.customHours ?? ''} onChange={e => uc({ reminders: form.communication.reminders.map(r => r.id === rule.id ? { ...r, customHours: Number(e.target.value) } : r) })} placeholder="hrs" />
              )}
              <div className="ml-auto flex items-center gap-1.5">
                {CHANNELS.map(ch => {
                  const on = rule.channels.includes(ch.id)
                  return (
                    <button key={ch.id} type="button" onClick={() => toggleReminderChannel(rule.id, ch.id)}
                      className={cn('rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors', on ? 'border-primary bg-primary/10 text-primary' : 'border-border/50 text-muted-foreground/60 hover:border-primary/30')}>
                      {ch.label}
                    </button>
                  )
                })}
                <button type="button" onClick={() => uc({ reminders: form.communication.reminders.filter(r => r.id !== rule.id) })} className="ml-1 flex size-5 items-center justify-center rounded text-muted-foreground/40 hover:bg-red-50 hover:text-red-500"><Trash2 className="size-3" aria-hidden /></button>
              </div>
            </div>
          ))}
          <button type="button" onClick={() => uc({ reminders: [...form.communication.reminders, { id: Math.random().toString(36).slice(2), enabled: true, timing: 'custom', customHours: 24, channels: ['email'] }] })}
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'w-full gap-1.5 border-dashed border-primary/30 text-primary/70')}>
            <Plus className="size-3" aria-hidden />Add Custom Reminder
          </button>
        </div>
      </SectionCard>

      <SectionCard title="Certificate & Badge">
        <div className="flex flex-col gap-3">
          <Toggle checked={form.communication.certificate.enabled} onChange={v => uc({ certificate: { ...form.communication.certificate, enabled: v } })} label="Issue Attendance Certificate" desc="PDF certificate sent with confirmation or on check-in" />
          {form.communication.certificate.enabled && (
            <div><label className={labelCls}>Certificate Template</label>
              <select className={inputCls} value={form.communication.certificate.template} onChange={e => uc({ certificate: { ...form.communication.certificate, template: e.target.value as 'default'|'custom' } })}>
                <option value="default">Default RegisterDesk Template</option>
                <option value="custom">Custom Template (upload later)</option>
              </select>
            </div>
          )}
        </div>
      </SectionCard>

      {/* Templates — collapsible */}
      <div className="overflow-hidden rounded-xl border border-border">
        <button type="button" onClick={() => setTplOpen(v => !v)} className="flex w-full items-center justify-between px-4 py-3.5 hover:bg-muted/[0.03]">
          <div className="flex items-center gap-2"><Settings2 className="size-4 text-muted-foreground" aria-hidden /><p className="text-[13px] font-semibold text-foreground">Custom Message Templates</p><span className="rounded-full bg-muted/60 px-2 py-px text-[10.5px] text-muted-foreground">Advanced</span></div>
          <ChevronDown className={cn('size-4 text-muted-foreground transition-transform', tplOpen && 'rotate-180')} aria-hidden />
        </button>
        <AnimatePresence>
          {tplOpen && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden border-t border-border">
              <div className="p-4">
                <div className="mb-3 flex overflow-x-auto border-b border-border/70">
                  {TPL_TABS.map(t => (
                    <button key={t.id} type="button" onClick={() => setTplTab(t.id)}
                      className={cn('shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-[11.5px] font-medium transition-colors', tplTab === t.id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}>
                      {t.label}
                    </button>
                  ))}
                </div>
                {tplTab === 'ce' && <div className="mb-2"><label className={labelCls}>Subject</label><input className={inputCls} value={tpl.subject} onChange={e => uc({ templates: { ...form.communication.templates, [tplKey[tplTab]]: { ...tpl, subject: e.target.value, isCustom: true } } })} placeholder="Your registration is confirmed — {{event_name}}" /></div>}
                <div>
                  <label className={labelCls}>Message Body</label>
                  <textarea className={cn(inputCls, 'h-36 resize-none py-2 font-mono text-[11.5px]')} value={tpl.body} onChange={e => uc({ templates: { ...form.communication.templates, [tplKey[tplTab]]: { ...tpl, body: e.target.value, isCustom: true } } })} placeholder="Hi {{attendee_name}},&#10;Your registration for {{event_name}} is confirmed!&#10;Date: {{event_date}}" />
                  <p className={hintCls}>Available tokens: <code className="text-primary">{'{{attendee_name}}'}</code> <code className="text-primary">{'{{event_name}}'}</code> <code className="text-primary">{'{{event_date}}'}</code> <code className="text-primary">{'{{venue}}'}</code> <code className="text-primary">{'{{pass_name}}'}</code> <code className="text-primary">{'{{qr_code_url}}'}</code></p>
                </div>
                {tpl.isCustom && (
                  <button type="button" onClick={() => uc({ templates: { ...form.communication.templates, [tplKey[tplTab]]: { subject: '', body: '', isCustom: false } } })} className="mt-2 text-[11.5px] text-muted-foreground hover:text-foreground">
                    Reset to default template
                  </button>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

// ─── Tab 5 — SEO & Discovery ──────────────────────────────────────────────────

function Tab5SEO({ form, update }: { form: EventDetailsDraft; update: (p: Partial<EventDetailsDraft>) => void }) {
  const us = (p: Partial<SeoConfig>) => update({ seo: { ...form.seo, ...p } })
  const [intOpen, setIntOpen] = useState(false)
  const [seoPreviewTab, setSeoPreviewTab] = useState<'google'|'social'>('google')

  const slug     = form.seo.urlSlug   || form.info.name && slugify(form.info.name)
  const title    = form.seo.metaTitle || form.info.name
  const desc     = form.seo.metaDescription || form.info.shortDesc
  const imgUrl   = form.seo.shareImageUrl || form.media.coverBanner.value

  return (
    <div className="flex flex-col gap-3">
      <SectionCard title="Event URL &amp; SEO">
        <div className="flex flex-col gap-3">
          <div>
            <label className={labelCls}>Event URL Slug <span className="text-red-500">*</span></label>
            <div className="flex items-center gap-0 overflow-hidden rounded-lg border border-border focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/20">
              <span className="shrink-0 whitespace-nowrap bg-muted/40 px-3 py-2 text-[12px] text-muted-foreground">registerdesk.co/e/</span>
              <input className="h-9 flex-1 bg-background px-2 text-[12.5px] text-foreground outline-none" value={form.seo.urlSlug} onChange={e => us({ urlSlug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} placeholder="event-name-2026" />
              <button type="button" onClick={() => us({ urlSlug: slugify(form.info.name) })} className="mr-1 flex items-center gap-1 rounded px-2 py-1 text-[11px] text-primary hover:bg-primary/10">
                <RefreshCw className="size-3" aria-hidden />Auto
              </button>
            </div>
            {form.seo.urlSlug && !/^[a-z0-9-]+$/.test(form.seo.urlSlug) && <p className="mt-1 text-[11px] text-red-500">Only lowercase letters, numbers and hyphens allowed.</p>}
          </div>
          <div>
            <div className="flex items-center justify-between"><label className={labelCls}>Meta Title</label><span className="text-[10.5px] text-muted-foreground">{(form.seo.metaTitle || title).length}/60</span></div>
            <input className={inputCls} maxLength={60} value={form.seo.metaTitle} onChange={e => us({ metaTitle: e.target.value })} placeholder={form.info.name || 'Your event name'} />
          </div>
          <div>
            <div className="flex items-center justify-between"><label className={labelCls}>Meta Description</label><span className="text-[10.5px] text-muted-foreground">{(form.seo.metaDescription || desc).length}/160</span></div>
            <textarea className={cn(inputCls, 'h-20 resize-none py-2')} maxLength={160} value={form.seo.metaDescription} onChange={e => us({ metaDescription: e.target.value })} placeholder={form.info.shortDesc || 'Brief event description for search results'} />
          </div>
          <div>
            <label className={labelCls}>Keywords <span className={hintCls.replace('mt-1 ', '')}>(comma-separated)</span></label>
            <input className={inputCls} value={form.seo.keywords.join(', ')} onChange={e => us({ keywords: e.target.value.split(',').map(k => k.trim()).filter(Boolean) })} placeholder="conference, technology, Mumbai, 2026" />
          </div>
          <UrlField label="Social Share Image" value={form.seo.shareImageUrl} onChange={v => us({ shareImageUrl: v })} hint="Defaults to cover banner — 1200×630 px recommended" preview="banner" />
          <div>
            <p className={labelCls}>UTM Tracking <span className={hintCls.replace('mt-1 ', '')}>(optional — appended to share links)</span></p>
            <div className="grid grid-cols-3 gap-2">
              <div><label className={hintCls + ' !mt-0'}>Source</label><input className={inputCls} value={form.seo.utmSource} onChange={e => us({ utmSource: e.target.value })} placeholder="facebook" /></div>
              <div><label className={hintCls + ' !mt-0'}>Medium</label><input className={inputCls} value={form.seo.utmMedium} onChange={e => us({ utmMedium: e.target.value })} placeholder="social" /></div>
              <div><label className={hintCls + ' !mt-0'}>Campaign</label><input className={inputCls} value={form.seo.utmCampaign} onChange={e => us({ utmCampaign: e.target.value })} placeholder="launch" /></div>
            </div>
          </div>
        </div>
      </SectionCard>

      {/* Live Preview */}
      <SectionCard title="Live Preview">
        <div className="mb-3 flex border-b border-border/60">
          {(['google','social'] as const).map(t => (
            <button key={t} type="button" onClick={() => setSeoPreviewTab(t)}
              className={cn('border-b-2 px-4 py-2 text-[12px] font-medium transition-colors', seoPreviewTab === t ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}>
              {t === 'google' ? 'Google Search' : 'Social Card'}
            </button>
          ))}
        </div>
        {seoPreviewTab === 'google' ? (
          <div className="rounded-lg border border-border/60 bg-card p-4">
            <p className="mb-1 text-[12px] text-emerald-600">registerdesk.co › e › {slug || 'your-event'}</p>
            <p className="mb-0.5 text-[16px] font-medium leading-snug text-blue-600 hover:underline cursor-pointer">{(title || 'Your Event Name').slice(0, 60)}</p>
            <p className="text-[12px] leading-relaxed text-muted-foreground">{(desc || 'Add a short description to improve click-through from search results.').slice(0, 160)}</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border/60">
            <div className="relative h-40 w-full bg-muted/30">
              {imgUrl ? <img src={imgUrl} alt="" className="h-full w-full object-cover" onError={e => { e.currentTarget.style.display = 'none' }} /> : <div className="flex h-full items-center justify-center"><p className="text-[12px] text-muted-foreground/50">No image — add a cover banner or share image</p></div>}
            </div>
            <div className="border-t border-border/60 bg-card p-3">
              <p className="text-[10.5px] uppercase tracking-wider text-muted-foreground/60">registerdesk.co</p>
              <p className="mt-0.5 text-[13px] font-semibold text-foreground">{(title || 'Your Event Name').slice(0, 60)}</p>
              <p className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">{(desc || 'Event description').slice(0, 100)}</p>
            </div>
          </div>
        )}
      </SectionCard>

      {/* Integrations — Coming Soon */}
      <div className="overflow-hidden rounded-xl border border-border">
        <button type="button" onClick={() => setIntOpen(v => !v)} className="flex w-full items-center justify-between px-4 py-3.5 hover:bg-muted/[0.03]">
          <div className="flex items-center gap-2"><Zap className="size-4 text-muted-foreground" aria-hidden /><p className="text-[13px] font-semibold text-foreground">Integrations</p><span className="rounded-full bg-amber-50 px-2 py-px text-[10.5px] font-semibold text-amber-600">Coming Soon</span></div>
          <ChevronDown className={cn('size-4 text-muted-foreground transition-transform', intOpen && 'rotate-180')} aria-hidden />
        </button>
        <AnimatePresence>
          {intOpen && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden border-t border-border">
              <div className="p-4">
                <div className="mb-4 flex items-start gap-2 rounded-lg border border-primary/10 bg-primary/[0.04] px-3 py-2"><Info className="mt-0.5 size-3.5 shrink-0 text-primary/70" aria-hidden /><p className="text-[11.5px] text-muted-foreground">Integrations are in development. Fields are shown for preview only and are not yet active.</p></div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {[
                    ['Webhook URL', 'webhookUrl', 'https://your-app.com/webhook'],
                    ['Zapier Catch Hook URL', 'zapierWebhookUrl', 'https://hooks.zapier.com/...'],
                    ['Google Analytics 4 ID', 'googleAnalyticsId', 'G-XXXXXXXXXX'],
                    ['Meta Pixel ID', 'metaPixelId', '123456789'],
                  ].map(([label, , ph]) => (
                    <div key={label}>
                      <label className={labelCls}>{label} <span className="ml-1 rounded bg-muted px-1 py-px text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">Disabled</span></label>
                      <input disabled className={cn(inputCls, 'cursor-not-allowed opacity-50')} placeholder={ph} />
                    </div>
                  ))}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

// ─── Tab 6 — Dynamic Event-Type Sections ──────────────────────────────────────

function Tab6Dynamic({
  form, update, tab6Config,
  onAddSpeaker, onEditSpeaker, onAddSponsor, onEditSponsor,
}: {
  form:          EventDetailsDraft
  update:        (p: Partial<EventDetailsDraft>) => void
  tab6Config:    Tab6Config
  onAddSpeaker:  (ctx: 'conference' | 'workshop' | 'cultural') => void
  onEditSpeaker: (s: Speaker, ctx: 'conference' | 'workshop' | 'cultural') => void
  onAddSponsor:  () => void
  onEditSponsor: (s: Sponsor) => void
}) {
  const utd = (d: typeof form.typeDetails) => update({ typeDetails: d })
  const t   = tab6Config.sectionType

  const SpeakerList = ({ speakers, ctx, onDelete }: { speakers: Speaker[]; ctx: 'conference'|'workshop'|'cultural'; onDelete: (id: string) => void }) => (
    <div>
      {speakers.length === 0 ? (
        <div className="mb-3 flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-muted/[0.03] py-8 text-center">
          <Mic className="size-6 text-muted-foreground/30" aria-hidden />
          <p className="text-[12px] text-muted-foreground">No {ctx === 'workshop' ? 'trainers' : ctx === 'cultural' ? 'artists' : 'speakers'} added yet</p>
        </div>
      ) : (
        <div className="mb-3 overflow-hidden rounded-xl border border-border">
          {speakers.map((s, i) => (
            <div key={s.id} className="flex items-center gap-3 border-b border-border/30 px-4 py-2.5 last:border-0 hover:bg-muted/[0.03]">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[12px] font-bold text-primary">{s.name?.[0]?.toUpperCase() || '?'}</div>
              <div className="min-w-0 flex-1"><p className="truncate text-[12.5px] font-medium text-foreground">{s.name || 'Unnamed'}</p><p className="text-[11.5px] text-muted-foreground">{[s.title, s.company].filter(Boolean).join(' · ')}</p></div>
              <div className="flex items-center gap-0.5">
                <button type="button" onClick={() => onEditSpeaker(s, ctx)} className="flex size-6 items-center justify-center rounded text-muted-foreground/40 hover:bg-primary/10 hover:text-primary"><Pencil className="size-3" aria-hidden /></button>
                <button type="button" onClick={() => onDelete(s.id)} className="flex size-6 items-center justify-center rounded text-muted-foreground/40 hover:bg-red-50 hover:text-red-500"><Trash2 className="size-3" aria-hidden /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => onAddSpeaker(ctx)} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-1.5 text-primary')}><Plus className="size-3.5" aria-hidden />Add New</button>
        <button type="button" disabled className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-1.5 cursor-not-allowed opacity-40')}><Upload className="size-3.5" aria-hidden />Select from Library <span className="ml-1 text-[9px] font-semibold uppercase">Soon</span></button>
      </div>
    </div>
  )

  if (t === 'conference') {
    const conf = (form.typeDetails ?? makeBlankTypeDetails('conference')) as ConferenceDetails
    const setConf = (p: Partial<ConferenceDetails>) => utd({ ...conf, ...p })
    return (
      <div className="flex flex-col gap-3">
        <SectionCard title="Speakers"><SpeakerList speakers={conf.speakers} ctx="conference" onDelete={id => setConf({ speakers: conf.speakers.filter(s => s.id !== id) })} /></SectionCard>
        <SectionCard title="Sponsors">
          <div>
            {conf.sponsors.length === 0 ? (
              <div className="mb-3 flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-muted/[0.03] py-8 text-center"><Star className="size-6 text-muted-foreground/30" aria-hidden /><p className="text-[12px] text-muted-foreground">No sponsors added yet</p></div>
            ) : (
              <div className="mb-3 overflow-hidden rounded-xl border border-border">
                {conf.sponsors.map(s => (
                  <div key={s.id} className="flex items-center gap-3 border-b border-border/30 px-4 py-2.5 last:border-0 hover:bg-muted/[0.03]">
                    <div className="min-w-0 flex-1"><p className="truncate text-[12.5px] font-medium text-foreground">{s.name}</p><p className="text-[11.5px] text-muted-foreground">{SPONSOR_TIER_LABELS[s.tier]}</p></div>
                    <div className="flex items-center gap-0.5">
                      <button type="button" onClick={() => onEditSponsor(s)} className="flex size-6 items-center justify-center rounded text-muted-foreground/40 hover:bg-primary/10 hover:text-primary"><Pencil className="size-3" aria-hidden /></button>
                      <button type="button" onClick={() => setConf({ sponsors: conf.sponsors.filter(sp => sp.id !== s.id) })} className="flex size-6 items-center justify-center rounded text-muted-foreground/40 hover:bg-red-50 hover:text-red-500"><Trash2 className="size-3" aria-hidden /></button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <button type="button" onClick={onAddSponsor} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-1.5 text-primary')}><Plus className="size-3.5" aria-hidden />Add Sponsor</button>
          </div>
        </SectionCard>
        <SectionCard title="Conference Tracks">
          <div>
            {conf.tracks.map(tr => (
              <div key={tr.id} className="flex items-center gap-3 border-b border-border/30 py-2 last:border-0">
                <input type="color" className="h-7 w-8 cursor-pointer rounded border border-border p-0.5" value={tr.color} onChange={e => setConf({ tracks: conf.tracks.map(t => t.id === tr.id ? { ...t, color: e.target.value } : t) })} />
                <input className={cn(inputCls, 'flex-1')} value={tr.name} onChange={e => setConf({ tracks: conf.tracks.map(t => t.id === tr.id ? { ...t, name: e.target.value } : t) })} placeholder="Track name" />
                <button type="button" onClick={() => setConf({ tracks: conf.tracks.filter(tt => tt.id !== tr.id) })} className="flex size-7 items-center justify-center rounded text-muted-foreground/40 hover:bg-red-50 hover:text-red-500"><Trash2 className="size-3" aria-hidden /></button>
              </div>
            ))}
            <button type="button" onClick={() => setConf({ tracks: [...conf.tracks, { id: makeTrackId(), name: '', color: '#6366f1' }] })} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'mt-2 gap-1.5 border-dashed border-primary/30 text-primary/70 w-full')}><Plus className="size-3" aria-hidden />Add Track</button>
          </div>
        </SectionCard>
      </div>
    )
  }

  if (t === 'sports_running') {
    const d = (form.typeDetails ?? makeBlankTypeDetails('sports_running')) as import('@/components/wizard/eventDetailsConfig').SportsRunningDetails
    const set = (p: Partial<typeof d>) => utd({ ...d, ...p })
    return (
      <div className="flex flex-col gap-3">
        <SectionCard title="Running Event Details">
          <div className="flex flex-col gap-3">
            <UrlField label="Route Map URL" value={d.routeMapUrl} onChange={v => set({ routeMapUrl: v })} />
            <div className="grid gap-3 sm:grid-cols-2">
              <div><label className={labelCls}>Reporting Time</label><input className={inputCls} value={d.reportingTime} onChange={e => set({ reportingTime: e.target.value })} placeholder="e.g. 5:00 AM at Start Line" /></div>
              <div><label className={labelCls}>Kit Collection Date</label><input type="date" className={inputCls} value={d.kitCollectionDate} onChange={e => set({ kitCollectionDate: e.target.value })} /></div>
            </div>
            <div><label className={labelCls}>Kit Collection Info</label><textarea className={cn(inputCls,'h-16 resize-none py-2')} value={d.kitCollectionInfo} onChange={e => set({ kitCollectionInfo: e.target.value })} /></div>
            <div><label className={labelCls}>Bag Deposit Info</label><textarea className={cn(inputCls,'h-16 resize-none py-2')} value={d.bagDepositInfo} onChange={e => set({ bagDepositInfo: e.target.value })} /></div>
            <div><label className={labelCls}>Medical Support Info</label><textarea className={cn(inputCls,'h-16 resize-none py-2')} value={d.medicalSupportInfo} onChange={e => set({ medicalSupportInfo: e.target.value })} /></div>
            <div><label className={labelCls}>Hydration Points</label><input className={inputCls} value={d.hydrationPoints} onChange={e => set({ hydrationPoints: e.target.value })} placeholder="e.g. Every 2.5 km, km 5, km 10, km 15" /></div>
            <div><label className={labelCls}>Start Line Info</label><input className={inputCls} value={d.startLineInfo} onChange={e => set({ startLineInfo: e.target.value })} /></div>
            <UrlField label="Rules URL" value={d.rulesUrl} onChange={v => set({ rulesUrl: v })} />
          </div>
        </SectionCard>
      </div>
    )
  }

  if (t === 'sports_team' || t === 'sports_cycling' || t === 'sports_generic') {
    const d = (form.typeDetails ?? makeBlankTypeDetails(t)) as import('@/components/wizard/eventDetailsConfig').TeamSportDetails
    const set = (p: Partial<typeof d>) => utd({ ...d, ...p })
    return (
      <SectionCard title={t === 'sports_cycling' ? 'Cycling Details' : 'Match Details'}>
        <div className="flex flex-col gap-3">
          <div><label className={labelCls}>{t === 'sports_cycling' ? 'Route Info' : 'Ground / Court Info'}</label><textarea className={cn(inputCls,'h-16 resize-none py-2')} value={d.groundInfo} onChange={e => set({ groundInfo: e.target.value })} /></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><label className={labelCls}>Format</label><input className={inputCls} value={d.matchFormat} onChange={e => set({ matchFormat: e.target.value })} placeholder={t === 'sports_cycling' ? 'e.g. Gran Fondo' : 'e.g. Knockout, League'} /></div>
            <div><label className={labelCls}>Team Size</label><input type="number" min={1} className={inputCls} value={d.teamSize ?? ''} onChange={e => set({ teamSize: e.target.value ? Number(e.target.value) : null })} placeholder="e.g. 11" /></div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><label className={labelCls}>Match Duration</label><input className={inputCls} value={d.matchDuration} onChange={e => set({ matchDuration: e.target.value })} placeholder="e.g. 45 minutes each half" /></div>
            <UrlField label="Rules URL" value={d.rulesUrl} onChange={v => set({ rulesUrl: v })} />
          </div>
        </div>
      </SectionCard>
    )
  }

  if (t === 'workshop') {
    const d = (form.typeDetails ?? makeBlankTypeDetails('workshop')) as WorkshopDetails
    const set = (p: Partial<WorkshopDetails>) => utd({ ...d, ...p })
    return (
      <div className="flex flex-col gap-3">
        <SectionCard title="Trainers"><SpeakerList speakers={d.trainers} ctx="workshop" onDelete={id => set({ trainers: d.trainers.filter(s => s.id !== id) })} /></SectionCard>
        <SectionCard title="Workshop Details">
          <div className="flex flex-col gap-3">
            <div><label className={labelCls}>Prerequisites</label><textarea className={cn(inputCls,'h-16 resize-none py-2')} value={d.prerequisites} onChange={e => set({ prerequisites: e.target.value })} /></div>
            <div><label className={labelCls}>Learning Outcomes <span className={hintCls.replace('mt-1 ','')}>(one per line)</span></label><textarea className={cn(inputCls,'h-24 resize-none py-2')} value={d.learningOutcomes.join('\n')} onChange={e => set({ learningOutcomes: e.target.value.split('\n') })} /></div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div><label className={labelCls}>Materials Included</label><textarea className={cn(inputCls,'h-16 resize-none py-2')} value={d.materialsIncluded} onChange={e => set({ materialsIncluded: e.target.value })} /></div>
              <div><label className={labelCls}>Software Required</label><input className={inputCls} value={d.softwareRequired} onChange={e => set({ softwareRequired: e.target.value })} /><div><label className={labelCls + ' mt-2'}>Batch Size</label><input type="number" min={1} className={inputCls} value={d.batchSize ?? ''} onChange={e => set({ batchSize: e.target.value ? Number(e.target.value) : null })} /></div></div>
            </div>
          </div>
        </SectionCard>
      </div>
    )
  }

  // ── Meetup ────────────────────────────────────────────────────────────────
  if (t === 'meetup_founder') {
    const d = (form.typeDetails ?? makeBlankTypeDetails('meetup_founder')) as import('@/components/wizard/eventDetailsConfig').MeetupFounderDetails
    const set = (p: Partial<typeof d>) => utd({ ...d, ...p })
    return (
      <SectionCard title="Founder Circle Details">
        <div className="flex flex-col gap-3">
          <Toggle checked={d.startupShowcaseEnabled} onChange={v => set({ startupShowcaseEnabled: v })} label="Startup Showcase" desc="Dedicated showcase area for startups to demo their products" />
          <Toggle checked={d.pitchSessionEnabled}    onChange={v => set({ pitchSessionEnabled: v })}    label="Pitch Session"    desc="Structured startup pitch presentation slots" />
          {d.pitchSessionEnabled && <div><label className={labelCls}>Pitch Format</label><input className={inputCls} value={d.pitchFormat} onChange={e => set({ pitchFormat: e.target.value })} placeholder="e.g. 5 min pitch + 3 min Q&A" /></div>}
          <Toggle checked={d.investorConnectEnabled} onChange={v => set({ investorConnectEnabled: v })} label="Investor Connect" desc="Dedicated networking between founders and investors" />
        </div>
      </SectionCard>
    )
  }

  if (t === 'meetup_corporate') {
    const d = (form.typeDetails ?? makeBlankTypeDetails('meetup_corporate')) as import('@/components/wizard/eventDetailsConfig').MeetupCorporateDetails
    const set = (p: Partial<typeof d>) => utd({ ...d, ...p })
    return (
      <SectionCard title="Corporate Meetup Details">
        <div className="flex flex-col gap-3">
          <div><label className={labelCls}>Guest Speakers <span className={hintCls.replace('mt-1 ','')}>(comma-separated names)</span></label><input className={inputCls} value={d.guestSpeakers.join(', ')} onChange={e => set({ guestSpeakers: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} /></div>
          <div><label className={labelCls}>Networking Agenda</label><textarea className={cn(inputCls,'h-24 resize-none py-2')} value={d.networkingAgenda} onChange={e => set({ networkingAgenda: e.target.value })} /></div>
        </div>
      </SectionCard>
    )
  }

  if (t === 'meetup_alumni') {
    const d = (form.typeDetails ?? makeBlankTypeDetails('meetup_alumni')) as import('@/components/wizard/eventDetailsConfig').MeetupAlumniDetails
    const set = (p: Partial<typeof d>) => utd({ ...d, ...p })
    return (
      <SectionCard title="Alumni Details">
        <div className="flex flex-col gap-3">
          <div><label className={labelCls}>Institution</label><input className={inputCls} value={d.institution} onChange={e => set({ institution: e.target.value })} placeholder="e.g. IIT Bombay, XLRI" /></div>
          <div><label className={labelCls}>Batch / Years</label><input className={inputCls} value={d.batchYears} onChange={e => set({ batchYears: e.target.value })} placeholder="e.g. 2010–2015 Batch" /></div>
          <div><label className={labelCls}>Reunion Activities</label><textarea className={cn(inputCls,'h-20 resize-none py-2')} value={d.reunionActivities} onChange={e => set({ reunionActivities: e.target.value })} /></div>
        </div>
      </SectionCard>
    )
  }

  if (t === 'cultural') {
    const d = (form.typeDetails ?? makeBlankTypeDetails('cultural')) as CulturalDetails
    const set = (p: Partial<CulturalDetails>) => utd({ ...d, ...p })
    return (
      <div className="flex flex-col gap-3">
        <SectionCard title="Artists &amp; Performers"><SpeakerList speakers={d.artists} ctx="cultural" onDelete={id => set({ artists: d.artists.filter(a => a.id !== id) })} /></SectionCard>
        <SectionCard title="Program Details">
          <div className="flex flex-col gap-3">
            <div><label className={labelCls}>Program Schedule</label><textarea className={cn(inputCls,'h-24 resize-none py-2')} value={d.programSchedule} onChange={e => set({ programSchedule: e.target.value })} /></div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div><label className={labelCls}>Entry Rules</label><input className={inputCls} value={d.entryRules} onChange={e => set({ entryRules: e.target.value })} placeholder="e.g. All ages welcome" /></div>
              <div><label className={labelCls}>Age Restriction</label><input className={inputCls} value={d.ageRestriction} onChange={e => set({ ageRestriction: e.target.value })} placeholder="e.g. 18+ only" /></div>
            </div>
          </div>
        </SectionCard>
      </div>
    )
  }

  if (t === 'awards') {
    const d = (form.typeDetails ?? makeBlankTypeDetails('awards')) as AwardsDetails
    const set = (p: Partial<AwardsDetails>) => utd({ ...d, ...p })
    return (
      <div className="flex flex-col gap-3">
        <SectionCard title="Award Categories">
          <div>
            {d.categories.map(cat => (
              <div key={cat.id} className="mb-2 rounded-lg border border-border/60 bg-muted/[0.03] p-3">
                <div className="flex items-center gap-2">
                  <input className={cn(inputCls, 'flex-1 text-[12.5px] font-medium')} value={cat.name} onChange={e => set({ categories: d.categories.map(c => c.id === cat.id ? { ...c, name: e.target.value } : c) })} placeholder="Category name" />
                  <button type="button" onClick={() => set({ categories: d.categories.filter(c => c.id !== cat.id) })} className="flex size-7 items-center justify-center rounded text-muted-foreground/40 hover:bg-red-50 hover:text-red-500"><Trash2 className="size-3" aria-hidden /></button>
                </div>
                <input className={cn(inputCls, 'mt-2')} value={cat.description} onChange={e => set({ categories: d.categories.map(c => c.id === cat.id ? { ...c, description: e.target.value } : c) })} placeholder="Category description" />
              </div>
            ))}
            <button type="button" onClick={() => set({ categories: [...d.categories, { id: makeAwardCatId(), name: '', description: '' }] })} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'w-full gap-1.5 border-dashed border-primary/30 text-primary/70')}><Plus className="size-3" aria-hidden />Add Category</button>
          </div>
        </SectionCard>
        <SectionCard title="Ceremony Details">
          <div className="flex flex-col gap-3">
            <div><label className={labelCls}>Nomination Rules</label><textarea className={cn(inputCls,'h-20 resize-none py-2')} value={d.nominationRules} onChange={e => set({ nominationRules: e.target.value })} /></div>
            <div><label className={labelCls}>Judging Process</label><textarea className={cn(inputCls,'h-20 resize-none py-2')} value={d.judgingProcess} onChange={e => set({ judgingProcess: e.target.value })} /></div>
            <div><label className={labelCls}>Ceremony Format</label><input className={inputCls} value={d.ceremonyFormat} onChange={e => set({ ceremonyFormat: e.target.value })} placeholder="e.g. Red carpet, gala dinner, trophy presentation" /></div>
          </div>
        </SectionCard>
      </div>
    )
  }

  if (t === 'fundraising') {
    const d = (form.typeDetails ?? makeBlankTypeDetails('fundraising')) as import('@/components/wizard/eventDetailsConfig').FundraisingDetails
    const set = (p: Partial<typeof d>) => utd({ ...d, ...p })
    return (
      <SectionCard title="Fundraising Details">
        <div className="flex flex-col gap-3">
          <div><label className={labelCls}>Beneficiary Info</label><textarea className={cn(inputCls,'h-20 resize-none py-2')} value={d.beneficiaryInfo} onChange={e => set({ beneficiaryInfo: e.target.value })} /></div>
          <div><label className={labelCls}>Fund Usage</label><textarea className={cn(inputCls,'h-16 resize-none py-2')} value={d.fundUsage} onChange={e => set({ fundUsage: e.target.value })} /></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><label className={labelCls}>Donation Goal (₹)</label><input type="number" min={0} className={inputCls} value={d.donationGoal ?? ''} onChange={e => set({ donationGoal: e.target.value ? Number(e.target.value) : null })} /></div>
            <div><label className={labelCls}>NGO Partner</label><input className={inputCls} value={d.ngoPartner} onChange={e => set({ ngoPartner: e.target.value })} /></div>
          </div>
          <div><label className={labelCls}>Tax Exemption Info</label><input className={inputCls} value={d.taxExemptionInfo} onChange={e => set({ taxExemptionInfo: e.target.value })} placeholder="e.g. 80G certificate provided" /></div>
        </div>
      </SectionCard>
    )
  }

  if (t === 'exhibition') {
    const d = (form.typeDetails ?? makeBlankTypeDetails('exhibition')) as import('@/components/wizard/eventDetailsConfig').ExhibitionDetails
    const set = (p: Partial<typeof d>) => utd({ ...d, ...p })
    return (
      <SectionCard title="Expo Details">
        <div className="flex flex-col gap-3">
          <UrlField label="Booth Info URL" value={d.boothInfoUrl} onChange={v => set({ boothInfoUrl: v })} />
          <UrlField label="Floor Plan URL" value={d.floorPlanUrl} onChange={v => set({ floorPlanUrl: v })} />
          <div><label className={labelCls}>Visitor Instructions</label><textarea className={cn(inputCls,'h-20 resize-none py-2')} value={d.visitorInstructions} onChange={e => set({ visitorInstructions: e.target.value })} /></div>
          <div><label className={labelCls}>Parking Info</label><textarea className={cn(inputCls,'h-16 resize-none py-2')} value={d.parkingInfo} onChange={e => set({ parkingInfo: e.target.value })} /></div>
        </div>
      </SectionCard>
    )
  }

  // community (default)
  const d = (form.typeDetails ?? makeBlankTypeDetails('community')) as import('@/components/wizard/eventDetailsConfig').CommunityDetails
  const set = (p: Partial<typeof d>) => utd({ ...d, ...p })
  return (
    <SectionCard title="Community Details">
      <div className="flex flex-col gap-3">
        <div><label className={labelCls}>Cause Info</label><textarea className={cn(inputCls,'h-16 resize-none py-2')} value={d.causeInfo} onChange={e => set({ causeInfo: e.target.value })} /></div>
        <div><label className={labelCls}>Volunteer Instructions</label><textarea className={cn(inputCls,'h-20 resize-none py-2')} value={d.volunteerInstructions} onChange={e => set({ volunteerInstructions: e.target.value })} /></div>
        <div><label className={labelCls}>Campaign Info</label><textarea className={cn(inputCls,'h-16 resize-none py-2')} value={d.campaignInfo} onChange={e => set({ campaignInfo: e.target.value })} /></div>
        <div><label className={labelCls}>Impact Goal</label><input className={inputCls} value={d.impactGoal} onChange={e => set({ impactGoal: e.target.value })} placeholder="e.g. Plant 10,000 trees by Dec 2026" /></div>
      </div>
    </SectionCard>
  )
}

// ─── Modals ───────────────────────────────────────────────────────────────────

function AgendaSessionModal({ session, isNew, eventDays, onSave, onCancel }: {
  session:   AgendaSession; isNew: boolean; eventDays: string[]
  onSave:    (s: AgendaSession) => void; onCancel: () => void
}) {
  const [draft, setDraft] = useState<AgendaSession>({ ...session })
  const upd = (p: Partial<AgendaSession>) => setDraft(prev => ({ ...prev, ...p }))
  const canSave = draft.title.trim().length > 0

  return (
    <>
      <motion.div key="as-bd" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 bg-black/40" onClick={onCancel} aria-hidden />
      <motion.div key="as-md" initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={{ duration: 0.25, ease: EASE }}
        className="fixed inset-x-0 bottom-0 top-12 z-50 mx-auto flex max-w-lg flex-col rounded-t-2xl border border-border bg-background shadow-xl sm:inset-x-4 sm:bottom-8 sm:top-auto sm:max-h-[85vh] sm:rounded-xl"
        role="dialog" aria-modal aria-label={isNew ? 'Add session' : 'Edit session'}>
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3.5">
          <p className="text-[14px] font-bold text-foreground">{isNew ? 'Add Session' : 'Edit Session'}</p>
          <button type="button" onClick={onCancel} className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/50"><X className="size-4" aria-hidden /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-5">
          <div className="flex flex-col gap-4">
            {eventDays.length > 1 && (
              <div><label className={labelCls}>Event Day</label><select className={inputCls} value={draft.date} onChange={e => upd({ date: e.target.value })}>{eventDays.map((d, i) => <option key={d} value={d}>{formatDayLabel(d, i)}</option>)}</select></div>
            )}
            <div><label className={labelCls}>Session Type</label><select className={inputCls} value={draft.type} onChange={e => upd({ type: e.target.value as typeof draft.type })}>{Object.entries(SESSION_TYPE_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></div>
            <div><label className={labelCls}>Title <span className="text-red-500">*</span></label><input className={inputCls} value={draft.title} onChange={e => upd({ title: e.target.value })} autoFocus placeholder="e.g. Opening Keynote" /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className={labelCls}>Start Time</label><input type="time" className={inputCls} value={draft.startTime} onChange={e => upd({ startTime: e.target.value })} /></div>
              <div><label className={labelCls}>End Time</label><input type="time" className={inputCls} value={draft.endTime} onChange={e => upd({ endTime: e.target.value })} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className={labelCls}>Location / Room</label><input className={inputCls} value={draft.location} onChange={e => upd({ location: e.target.value })} placeholder="e.g. Main Hall" /></div>
              <div><label className={labelCls}>Track</label><input className={inputCls} value={draft.track} onChange={e => upd({ track: e.target.value })} placeholder="e.g. Technology" /></div>
            </div>
            <div><label className={labelCls}>Description</label><textarea className={cn(inputCls, 'h-20 resize-none py-2')} value={draft.description} onChange={e => upd({ description: e.target.value })} /></div>
            <Toggle checked={draft.isBreak} onChange={v => upd({ isBreak: v })} label="This is a break / intermission" desc="Break sessions are styled differently on the agenda" />
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button type="button" onClick={onCancel} className={buttonVariants({ variant: 'outline' })}>Cancel</button>
          <button type="button" onClick={() => canSave && onSave(draft)} disabled={!canSave} className={cn(buttonVariants({ variant: 'primary' }), !canSave && 'cursor-not-allowed opacity-50')}>{isNew ? 'Add Session' : 'Save Changes'}</button>
        </div>
      </motion.div>
    </>
  )
}

function SpeakerModal({ speaker, isNew, contextLabel, onSave, onCancel }: {
  speaker: Speaker; isNew: boolean; contextLabel: string
  onSave: (s: Speaker) => void; onCancel: () => void
}) {
  const [draft, setDraft] = useState<Speaker>({ ...speaker })
  const upd = (p: Partial<Speaker>) => setDraft(prev => ({ ...prev, ...p }))
  const canSave = draft.name.trim().length > 0

  return (
    <>
      <motion.div key="sp-bd" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 bg-black/40" onClick={onCancel} aria-hidden />
      <motion.div key="sp-md" initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={{ duration: 0.25, ease: EASE }}
        className="fixed inset-x-0 bottom-0 top-12 z-50 mx-auto flex max-w-lg flex-col rounded-t-2xl border border-border bg-background shadow-xl sm:inset-x-4 sm:bottom-8 sm:top-auto sm:max-h-[85vh] sm:rounded-xl"
        role="dialog" aria-modal aria-label={isNew ? `Add ${contextLabel}` : `Edit ${contextLabel}`}>
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3.5">
          <p className="text-[14px] font-bold text-foreground">{isNew ? `Add ${contextLabel}` : `Edit ${contextLabel}`}</p>
          <button type="button" onClick={onCancel} className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/50"><X className="size-4" aria-hidden /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-5">
          <div className="flex flex-col gap-4">
            <UrlField label="Photo URL" value={draft.photoUrl} onChange={v => upd({ photoUrl: v })} hint="Square image — 300×300 px recommended" preview="square" />
            <div><label className={labelCls}>Name <span className="text-red-500">*</span></label><input className={inputCls} autoFocus value={draft.name} onChange={e => upd({ name: e.target.value })} placeholder="Full name" /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className={labelCls}>Title / Role</label><input className={inputCls} value={draft.title} onChange={e => upd({ title: e.target.value })} placeholder="e.g. CEO, Speaker" /></div>
              <div><label className={labelCls}>Company / Organisation</label><input className={inputCls} value={draft.company} onChange={e => upd({ company: e.target.value })} /></div>
            </div>
            <div><label className={labelCls}>Bio <span className={hintCls.replace('mt-1 ','')}>(400 chars)</span></label><textarea className={cn(inputCls, 'h-24 resize-none py-2')} maxLength={400} value={draft.bio} onChange={e => upd({ bio: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className={labelCls}>LinkedIn URL</label><input type="url" className={inputCls} value={draft.social.linkedin} onChange={e => upd({ social: { ...draft.social, linkedin: e.target.value } })} /></div>
              <div><label className={labelCls}>Twitter/X URL</label><input type="url" className={inputCls} value={draft.social.twitter} onChange={e => upd({ social: { ...draft.social, twitter: e.target.value } })} /></div>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button type="button" onClick={onCancel} className={buttonVariants({ variant: 'outline' })}>Cancel</button>
          <button type="button" onClick={() => canSave && onSave(draft)} disabled={!canSave} className={cn(buttonVariants({ variant: 'primary' }), !canSave && 'cursor-not-allowed opacity-50')}>{isNew ? `Add ${contextLabel}` : 'Save Changes'}</button>
        </div>
      </motion.div>
    </>
  )
}

function SponsorModal({ sponsor, isNew, onSave, onCancel }: {
  sponsor: Sponsor; isNew: boolean; onSave: (s: Sponsor) => void; onCancel: () => void
}) {
  const [draft, setDraft] = useState<Sponsor>({ ...sponsor })
  const upd = (p: Partial<Sponsor>) => setDraft(prev => ({ ...prev, ...p }))
  const canSave = draft.name.trim().length > 0

  return (
    <>
      <motion.div key="spo-bd" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 bg-black/40" onClick={onCancel} aria-hidden />
      <motion.div key="spo-md" initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={{ duration: 0.25, ease: EASE }}
        className="fixed inset-x-0 bottom-0 top-12 z-50 mx-auto flex max-w-lg flex-col rounded-t-2xl border border-border bg-background shadow-xl sm:inset-x-4 sm:bottom-8 sm:top-auto sm:max-h-[80vh] sm:rounded-xl"
        role="dialog" aria-modal aria-label={isNew ? 'Add Sponsor' : 'Edit Sponsor'}>
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3.5">
          <p className="text-[14px] font-bold text-foreground">{isNew ? 'Add Sponsor' : 'Edit Sponsor'}</p>
          <button type="button" onClick={onCancel} className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/50"><X className="size-4" aria-hidden /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-5">
          <div className="flex flex-col gap-4">
            <div><label className={labelCls}>Sponsor Name <span className="text-red-500">*</span></label><input className={inputCls} autoFocus value={draft.name} onChange={e => upd({ name: e.target.value })} /></div>
            <div><label className={labelCls}>Sponsorship Tier</label><select className={inputCls} value={draft.tier} onChange={e => upd({ tier: e.target.value as typeof draft.tier })}>{Object.entries(SPONSOR_TIER_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></div>
            <UrlField label="Logo URL" value={draft.logoUrl} onChange={v => upd({ logoUrl: v })} hint="Square or landscape PNG/SVG" preview="square" />
            <div><label className={labelCls}>Website URL</label><input type="url" className={inputCls} value={draft.website} onChange={e => upd({ website: e.target.value })} /></div>
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button type="button" onClick={onCancel} className={buttonVariants({ variant: 'outline' })}>Cancel</button>
          <button type="button" onClick={() => canSave && onSave(draft)} disabled={!canSave} className={cn(buttonVariants({ variant: 'primary' }), !canSave && 'cursor-not-allowed opacity-50')}>{isNew ? 'Add Sponsor' : 'Save Changes'}</button>
        </div>
      </motion.div>
    </>
  )
}

// ─── Summary Panel ────────────────────────────────────────────────────────────

function SummaryPanel({ form, eventTypeId, eventSubtype, tab6Config, onPreview, passes }: {
  form: EventDetailsDraft; eventTypeId?: string | null; eventSubtype?: string | null
  tab6Config: Tab6Config | null; onPreview: () => void
  passes: { id: string; name: string; price: number; type: 'paid'|'free' }[]
}) {
  const health = calcStepHealth(form)

  const STATUS_COLORS: Record<string, string> = {
    draft: 'bg-muted text-muted-foreground', published: 'bg-emerald-50 text-emerald-700',
    private: 'bg-blue-50 text-blue-700', postponed: 'bg-amber-50 text-amber-700',
    cancelled: 'bg-rose-50 text-rose-600', sold_out: 'bg-violet-50 text-violet-700',
    archived: 'bg-muted/60 text-muted-foreground/60',
  }

  const barColor = health.score >= 80 ? 'bg-emerald-500' : health.score >= 50 ? 'bg-amber-500' : 'bg-rose-500'

  const venueDisplay = (() => {
    if (form.venue.type === 'physical' || form.venue.type === 'hybrid') return form.venue.physical.name || 'Physical'
    return ONLINE_PLATFORM_LABELS[form.venue.online.platform] || 'Online'
  })()

  const startDisplay = (() => {
    if (!form.schedule.startDate) return null
    try {
      const d = new Date(`${form.schedule.startDate}T${form.schedule.startTime || '00:00'}`)
      return d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) + (form.schedule.startTime ? `, ${fmtTime(form.schedule.startTime)}` : '')
    } catch { return form.schedule.startDate }
  })()

  const CHECKLIST: [boolean, boolean, string][] = [
    [!!form.info.name.trim(), true,  'Event Name'],
    [!!form.media.coverBanner.value.trim(), false, 'Cover Banner'],
    [!!(form.venue.type && (form.venue.type !== 'physical' || form.venue.physical.name)), true, 'Venue Configured'],
    [!!(form.schedule.startDate && form.schedule.endDate), true, 'Dates & Times'],
    [!!(form.organizer.name.trim() && form.organizer.email.trim()), true, 'Organizer Info'],
    [(form.communication.confirmation.channels?.length ?? 0) > 0, false, 'Notification Channel'],
    [!!(form.seo.urlSlug && /^[a-z0-9-]+$/.test(form.seo.urlSlug)), true, 'URL Slug'],
  ]

  return (
    <div className="flex flex-col gap-3">
      <button type="button" onClick={onPreview} disabled={!form.info.name.trim()}
        className={cn(buttonVariants({ variant: 'outline' }), 'w-full gap-2', !form.info.name.trim() && 'pointer-events-none opacity-50')}>
        <Eye className="size-4" aria-hidden />Preview Event Page
      </button>

      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Step Health</p>
          <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-bold', health.score >= 80 ? 'bg-emerald-50 text-emerald-700' : health.score >= 50 ? 'bg-amber-50 text-amber-700' : 'bg-rose-50 text-rose-600')}>{health.score}%</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-border"><div className={cn('h-full rounded-full transition-all duration-500', barColor)} style={{ width: `${health.score}%` }} /></div>
        <div className="mt-2 flex items-center gap-3 text-[11px]">
          {health.blockers.length > 0 && <span className="text-rose-600">{health.blockers.length} blocker{health.blockers.length > 1 ? 's' : ''}</span>}
          {health.warnings.length > 0 && <span className="text-amber-600">{health.warnings.length} warning{health.warnings.length > 1 ? 's' : ''}</span>}
          {health.blockers.length === 0 && health.warnings.length === 0 && <span className="text-emerald-600">All good!</span>}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <p className="mb-3 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Event Status</p>
        <span className={cn('rounded-full px-2.5 py-1 text-[11.5px] font-semibold', STATUS_COLORS[form.status.status] ?? 'bg-muted text-muted-foreground')}>{EVENT_STATUS_LABELS[form.status.status]}</span>
      </div>

      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <p className="mb-3 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Event Details</p>
        <div className="flex flex-col gap-2 text-[12px]">
          {eventTypeId && <div className="flex justify-between gap-2"><span className="text-muted-foreground">Type</span><span className="text-right font-medium text-foreground capitalize">{eventTypeId}{eventSubtype ? ` · ${eventSubtype}` : ''}</span></div>}
          <div className="flex justify-between gap-2"><span className="text-muted-foreground">Theme</span><span className="font-medium text-foreground capitalize">{form.media.theme}</span></div>
          {venueDisplay && <div className="flex justify-between gap-2"><span className="text-muted-foreground">Venue</span><span className="truncate text-right font-medium text-foreground">{venueDisplay}</span></div>}
          {startDisplay && <div className="flex justify-between gap-2"><span className="shrink-0 text-muted-foreground">Start</span><span className="text-right font-medium text-foreground">{startDisplay}</span></div>}
          {form.organizer.name && <div className="flex justify-between gap-2"><span className="text-muted-foreground">Organizer</span><span className="truncate text-right font-medium text-foreground">{form.organizer.name}</span></div>}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <p className="mb-3 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Section Checklist</p>
        <div className="flex flex-col gap-1.5">
          {CHECKLIST.map(([done, required, label]) => (
            <div key={label} className="flex items-center gap-2">
              <span className={cn('flex size-4 shrink-0 items-center justify-center rounded-full text-[9px]', done ? 'bg-emerald-50 text-emerald-600' : required ? 'bg-rose-50 text-rose-500' : 'bg-amber-50 text-amber-500')}>
                {done ? '✓' : required ? '!' : '⚠'}
              </span>
              <p className={cn('text-[11.5px]', done ? 'text-foreground' : 'text-muted-foreground')}>{label}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <p className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Public Page</p>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(form.publicPage).map(([key, on]) => (
            <span key={key} className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', on ? 'bg-emerald-50 text-emerald-700' : 'bg-muted text-muted-foreground/50')}>
              {key.replace('show', '').replace(/([A-Z])/g, ' $1').trim()}
            </span>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <p className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Communication</p>
        <div className="flex flex-wrap gap-1.5">
          {(['email','whatsapp','sms'] as CommChannel[]).map(ch => {
            const on = form.communication.confirmation.channels.includes(ch)
            return <span key={ch} className={cn('rounded-full px-2 py-0.5 text-[10.5px] font-semibold capitalize', on ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground/50')}>{ch}</span>
          })}
          {form.communication.confirmation.calendarInvite && <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10.5px] font-semibold text-blue-600">Calendar ICS</span>}
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">{form.communication.reminders.filter(r => r.enabled).length} active reminder{form.communication.reminders.filter(r => r.enabled).length !== 1 ? 's' : ''}</p>
      </div>
    </div>
  )
}

// ─── Preview Modal ────────────────────────────────────────────────────────────

function PreviewModal({ form, passes, onClose }: {
  form: EventDetailsDraft; passes: { id: string; name: string; price: number; type: 'paid'|'free' }[]; onClose: () => void
}) {
  const statusBannerStyle: Partial<Record<string, string>> = {
    postponed: 'bg-amber-50 text-amber-700 border-amber-200/60',
    cancelled: 'bg-rose-50 text-rose-600 border-rose-200/60',
    sold_out:  'bg-violet-50 text-violet-700 border-violet-200/60',
    draft:     'bg-muted text-muted-foreground border-border',
  }

  const bannerStyle = statusBannerStyle[form.status.status]

  return (
    <>
      <motion.div key="pv-bd" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 bg-black/50" onClick={onClose} aria-hidden />
      <motion.div key="pv-md" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} transition={{ duration: 0.25, ease: EASE }}
        className="fixed inset-x-4 bottom-4 top-4 z-50 mx-auto flex max-w-[600px] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
        role="dialog" aria-modal aria-label="Event page preview">
        <div className="flex shrink-0 items-center justify-between border-b border-border bg-muted/[0.03] px-6 py-4">
          <div className="flex items-center gap-2.5"><div className="flex size-8 items-center justify-center rounded-lg bg-primary/10"><Eye className="size-4 text-primary" aria-hidden /></div><div><p className="text-[14px] font-bold text-foreground">Event Page Preview</p><p className="text-[11.5px] text-muted-foreground">Draft — not visible to the public</p></div></div>
          <button type="button" onClick={onClose} className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/50 hover:text-foreground"><X className="size-5" aria-hidden /></button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {bannerStyle && (
            <div className={cn('border-b px-6 py-3 text-[12.5px] font-medium', bannerStyle)}>
              {form.status.status === 'postponed' && `Postponed${form.status.postponedDate ? ` — new date: ${form.status.postponedDate}` : ' — new date TBD'}`}
              {form.status.status === 'cancelled' && 'This event has been cancelled.'}
              {form.status.status === 'sold_out'  && 'Registrations are full. Waitlist may be active.'}
              {form.status.status === 'draft'     && 'Draft preview — this event is not yet published.'}
            </div>
          )}
          <div className="relative h-48 w-full bg-muted/30">
            {form.media.coverBanner.value ? <img src={form.media.coverBanner.value} alt="" className="h-full w-full object-cover" onError={e => { e.currentTarget.style.display='none' }} /> : <div className="flex h-full items-center justify-center"><p className="text-[12px] text-muted-foreground/50">Add a cover banner to improve your event page</p></div>}
          </div>
          <div className="px-6 py-5">
            <h1 className="text-[1.4rem] font-bold tracking-tight text-foreground">{form.info.name || 'Your Event Name'}</h1>
            {form.info.tagline && <p className="mt-1 text-[13.5px] text-muted-foreground">{form.info.tagline}</p>}
            <div className="mt-3 flex flex-wrap gap-3 text-[12.5px] text-muted-foreground">
              {form.schedule.startDate && <span className="flex items-center gap-1"><Calendar className="size-3.5" aria-hidden />{form.schedule.startDate}{form.schedule.startTime ? ` · ${fmtTime(form.schedule.startTime)}` : ''}</span>}
              {(form.venue.physical.name || form.venue.online.platform) && <span className="flex items-center gap-1"><MapPin className="size-3.5" aria-hidden />{form.venue.type === 'online' ? ONLINE_PLATFORM_LABELS[form.venue.online.platform] : form.venue.physical.name}</span>}
            </div>
            {form.info.shortDesc && <p className="mt-4 text-[13px] leading-relaxed text-foreground">{form.info.shortDesc}</p>}
            {passes.length > 0 && (
              <div className="mt-5">
                <p className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Passes</p>
                <div className="flex flex-col gap-2">
                  {passes.map(p => (
                    <div key={p.id} className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3">
                      <p className="text-[13px] font-semibold text-foreground">{p.name}</p>
                      <p className="text-[13px] font-bold text-primary">{p.type === 'free' ? 'Free' : `₹${p.price.toLocaleString('en-IN')}`}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {form.organizer.name && <p className="mt-5 text-[12px] text-muted-foreground">Organised by <span className="font-semibold text-foreground">{form.organizer.name}</span></p>}
          </div>
        </div>
        <div className="shrink-0 border-t border-border px-6 py-4">
          <button type="button" disabled className={cn(buttonVariants({ variant: 'primary' }), 'w-full cursor-not-allowed opacity-60')}>Register Now</button>
          <p className="mt-2 text-center text-[11px] text-muted-foreground">Preview only — registration is disabled</p>
        </div>
      </motion.div>
    </>
  )
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export interface EventDetailsBuilderProps {
  form:           EventDetailsDraft
  onChange:       (f: EventDetailsDraft) => void
  eventTypeId?:   string | null
  eventSubtype?:  string | null
  pricingPasses?: { id: string; name: string; price: number; type: 'paid' | 'free' }[]
  uploadContext?: { uid: string; draftId: string }
}

export function EventDetailsBuilder({
  form: rawForm, onChange, eventTypeId, eventSubtype, pricingPasses = [], uploadContext,
}: EventDetailsBuilderProps) {
  const blank = makeBlankEventDetailsDraft()
  const raw   = rawForm ?? blank
  const form: EventDetailsDraft = {
    ...blank, ...raw,
    status:        { ...blank.status,        ...(raw.status        ?? {}) },
    info:          { ...blank.info,          ...(raw.info          ?? {}) },
    media:         { ...blank.media,         ...(raw.media         ?? {}) },
    venue: { ...blank.venue, ...(raw.venue ?? {}),
      physical: { ...blank.venue.physical, ...(raw.venue?.physical ?? {}), maps: { ...blank.venue.physical.maps, ...(raw.venue?.physical?.maps ?? {}) } },
      online:   { ...blank.venue.online,   ...(raw.venue?.online   ?? {}) },
    },
    schedule:      { ...blank.schedule,      ...(raw.schedule      ?? {}) },
    organizer:     { ...blank.organizer,     ...(raw.organizer     ?? {}), social: { ...blank.organizer.social, ...(raw.organizer?.social ?? {}) } },
    communication: { ...blank.communication, ...(raw.communication ?? {}),
      confirmation: { ...blank.communication.confirmation, ...(raw.communication?.confirmation ?? {}) },
      templates:    { ...blank.communication.templates,    ...(raw.communication?.templates    ?? {}) },
      certificate:  { ...blank.communication.certificate,  ...(raw.communication?.certificate  ?? {}) },
    },
    support:      { ...blank.support,      ...(raw.support      ?? {}), refundWindow: { ...blank.support.refundWindow, ...(raw.support?.refundWindow ?? {}) } },
    seo:          { ...blank.seo,          ...(raw.seo          ?? {}) },
    publicPage:   { ...blank.publicPage,   ...(raw.publicPage   ?? {}) },
    integrations: { ...blank.integrations, ...(raw.integrations ?? {}) },
    typeDetails:  raw.typeDetails ?? null,
  }

  const [activeTab,       setActiveTab]       = useState<Tab>('details')
  const [editingSession,  setEditingSession]  = useState<AgendaSession | null>(null)
  const [isNewSession,    setIsNewSession]    = useState(false)
  const [editingSpeaker,  setEditingSpeaker]  = useState<{ speaker: Speaker; ctx: 'conference'|'workshop'|'cultural' } | null>(null)
  const [isNewSpeaker,    setIsNewSpeaker]    = useState(false)
  const [editingSponsor,  setEditingSponsor]  = useState<Sponsor | null>(null)
  const [isNewSponsor,    setIsNewSponsor]    = useState(false)
  const [previewOpen,     setPreviewOpen]     = useState(false)

  const tab6Config = getTab6Config(eventTypeId, eventSubtype)
  const update = (p: Partial<EventDetailsDraft>) => onChange({ ...form, ...p })

  // Ensure typeDetails is initialized when tab6Config is available
  const effectiveForm = (tab6Config && !form.typeDetails)
    ? { ...form, typeDetails: makeBlankTypeDetails(tab6Config.sectionType) }
    : form

  const TABS = [
    ...BASE_TABS,
    ...(tab6Config ? [{ id: 'type' as Tab, label: tab6Config.tabTitle, icon: Trophy }] : []),
  ]

  // Session handlers
  const handleAddSession = (date: string, order: number) => {
    setEditingSession(makeBlankSession(date, order)); setIsNewSession(true)
  }
  const handleEditSession   = (s: AgendaSession) => { setEditingSession({ ...s }); setIsNewSession(false) }
  const handleDeleteSession = (id: string) => update({ schedule: { ...effectiveForm.schedule, agenda: effectiveForm.schedule.agenda.filter(s => s.id !== id) } })
  const handleMoveSession   = (id: string, dir: 'up'|'down') => {
    const agenda = [...effectiveForm.schedule.agenda].sort((a, b) => a.order - b.order)
    const idx    = agenda.findIndex(s => s.id === id); if (idx < 0) return
    const swap   = dir === 'up' ? idx - 1 : idx + 1; if (swap < 0 || swap >= agenda.length) return
    ;[agenda[idx]!, agenda[swap]!] = [{ ...agenda[swap]!, order: agenda[idx]!.order }, { ...agenda[idx]!, order: agenda[swap]!.order }]
    update({ schedule: { ...effectiveForm.schedule, agenda } })
  }
  const handleSaveSession = (s: AgendaSession) => {
    const agenda = isNewSession ? [...effectiveForm.schedule.agenda, s] : effectiveForm.schedule.agenda.map(x => x.id === s.id ? s : x)
    update({ schedule: { ...effectiveForm.schedule, agenda } })
    setEditingSession(null)
  }

  // Speaker handlers
  const saveSpeakerToForm = (s: Speaker, ctx: 'conference'|'workshop'|'cultural') => {
    if (!effectiveForm.typeDetails) return
    if (ctx === 'conference') {
      const d = effectiveForm.typeDetails as ConferenceDetails
      update({ typeDetails: { ...d, speakers: isNewSpeaker ? [...d.speakers, s] : d.speakers.map(x => x.id === s.id ? s : x) } })
    } else if (ctx === 'workshop') {
      const d = effectiveForm.typeDetails as WorkshopDetails
      update({ typeDetails: { ...d, trainers: isNewSpeaker ? [...d.trainers, s] : d.trainers.map(x => x.id === s.id ? s : x) } })
    } else {
      const d = effectiveForm.typeDetails as CulturalDetails
      update({ typeDetails: { ...d, artists: isNewSpeaker ? [...d.artists, s] : d.artists.map(x => x.id === s.id ? s : x) } })
    }
    setEditingSpeaker(null)
  }

  // Sponsor handlers
  const saveSponsorToForm = (s: Sponsor) => {
    if (!effectiveForm.typeDetails) return
    const d = effectiveForm.typeDetails as ConferenceDetails
    update({ typeDetails: { ...d, sponsors: isNewSponsor ? [...d.sponsors, s] : d.sponsors.map(x => x.id === s.id ? s : x) } })
    setEditingSponsor(null)
  }

  const speakerLabel = editingSpeaker?.ctx === 'workshop' ? 'Trainer' : editingSpeaker?.ctx === 'cultural' ? 'Artist' : 'Speaker'

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[1fr_260px]">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div className="flex overflow-x-auto border-b border-border/70">
            {TABS.map(tab => {
              const Icon = tab.icon
              return (
                <button key={tab.id} type="button" onClick={() => setActiveTab(tab.id)}
                  className={cn('flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-4 py-2.5 text-[12px] font-medium transition-colors', activeTab === tab.id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}>
                  <Icon className="size-3.5" aria-hidden />{tab.label}
                </button>
              )
            })}
          </div>
          <div className="p-4">
            {activeTab === 'details'   && <Tab1Details   form={effectiveForm} update={update} uploadContext={uploadContext} />}
            {activeTab === 'venue'     && <Tab2VenueSchedule form={effectiveForm} update={update} onAddSession={handleAddSession} onEditSession={handleEditSession} onDeleteSession={handleDeleteSession} onMoveSession={handleMoveSession} />}
            {activeTab === 'organizer' && <Tab3Organizer form={effectiveForm} update={update} />}
            {activeTab === 'comms'     && <Tab4Communication form={effectiveForm} update={update} />}
            {activeTab === 'seo'       && <Tab5SEO        form={effectiveForm} update={update} />}
            {activeTab === 'type' && tab6Config && (
              <Tab6Dynamic form={effectiveForm} update={update} tab6Config={tab6Config}
                onAddSpeaker={ctx => { setEditingSpeaker({ speaker: { ...makeBlankSpeaker(), order: 0 }, ctx }); setIsNewSpeaker(true) }}
                onEditSpeaker={(s, ctx) => { setEditingSpeaker({ speaker: s, ctx }); setIsNewSpeaker(false) }}
                onAddSponsor={() => { setEditingSponsor({ ...makeBlankSponsor(), order: 0 }); setIsNewSponsor(true) }}
                onEditSponsor={s => { setEditingSponsor(s); setIsNewSponsor(false) }}
              />
            )}
          </div>
        </div>
      </div>

      <div className="lg:sticky lg:top-4">
        <SummaryPanel form={effectiveForm} eventTypeId={eventTypeId} eventSubtype={eventSubtype} tab6Config={tab6Config} onPreview={() => setPreviewOpen(true)} passes={pricingPasses} />
      </div>

      <AnimatePresence>
        {editingSession && (
          <AgendaSessionModal session={editingSession} isNew={isNewSession}
            eventDays={getEventDays(effectiveForm.schedule.startDate, effectiveForm.schedule.endDate)}
            onSave={handleSaveSession} onCancel={() => setEditingSession(null)} />
        )}
        {editingSpeaker && (
          <SpeakerModal speaker={editingSpeaker.speaker} isNew={isNewSpeaker} contextLabel={speakerLabel}
            onSave={s => saveSpeakerToForm(s, editingSpeaker.ctx)} onCancel={() => setEditingSpeaker(null)} />
        )}
        {editingSponsor && (
          <SponsorModal sponsor={editingSponsor} isNew={isNewSponsor}
            onSave={saveSponsorToForm} onCancel={() => setEditingSponsor(null)} />
        )}
        {previewOpen && (
          <PreviewModal form={effectiveForm} passes={pricingPasses} onClose={() => setPreviewOpen(false)} />
        )}
      </AnimatePresence>
    </div>
  )
}

