'use client'

import { useState } from 'react'
import { Loader2, Upload, Images } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { uploadCertificateAsset } from '@/lib/firebase/storage'
import { FONT_FAMILIES } from '@/lib/certificates/constants'
import { VariablePicker } from './VariablePicker'
import AssetPickerModal from './AssetPickerModal'
import type { CertificateDimensions, LayoutElement, FontFamily } from '@/lib/certificates/types'

interface Props {
  element:     LayoutElement | null
  multiCount:  number
  canvas:      CertificateDimensions
  eventId:     string
  uid:         string
  onChange:    (patch: Partial<LayoutElement>) => void
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  )
}

const numCls = 'h-7 w-16 rounded-md border border-border bg-card px-2 text-[12px] text-foreground focus:border-primary/40 focus:outline-none'

function pct(v: number | undefined) { return Math.round((v ?? 0) * 100) }

export default function PropertiesPanel({ element, multiCount, canvas, eventId, uid, onChange }: Props) {
  const [uploading, setUploading] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)

  if (multiCount > 1) {
    return <PanelShell><p className="text-[13px] text-muted-foreground">{multiCount} elements selected. Use the canvas to move them, or the Layers panel to manage each.</p></PanelShell>
  }
  if (!element) {
    return <PanelShell><p className="text-[13px] text-muted-foreground">Select an element to edit its properties.</p></PanelShell>
  }
  const el = element

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const url = await uploadCertificateAsset(uid, eventId, file)
      onChange({ assetUrl: url } as Partial<LayoutElement>)
    } catch { /* surfaced by missing image */ } finally {
      setUploading(false)
    }
  }

  return (
    <PanelShell>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{el.type}{el.type === 'image' && el.role ? ` · ${el.role}` : ''}</p>

      {/* Position & size */}
      <Section title="Layout">
        <Row label="X %"><input type="number" className={numCls} value={pct(el.x)} onChange={e => onChange({ x: Number(e.target.value) / 100 })} /></Row>
        <Row label="Y %"><input type="number" className={numCls} value={pct(el.y)} onChange={e => onChange({ y: Number(e.target.value) / 100 })} /></Row>
        {el.type !== 'text' && (
          <>
            <Row label="Width %"><input type="number" className={numCls} value={pct(el.width)} onChange={e => onChange({ width: Number(e.target.value) / 100 })} /></Row>
            {el.type !== 'line' && <Row label="Height %"><input type="number" className={numCls} value={pct(el.height)} onChange={e => onChange({ height: Number(e.target.value) / 100 })} /></Row>}
          </>
        )}
        {el.type === 'text' && (
          <Row label="Width %"><input type="number" className={numCls} value={pct(el.width)} onChange={e => onChange({ width: Number(e.target.value) / 100 })} /></Row>
        )}
        <Row label="Rotation°"><input type="number" className={numCls} value={Math.round(el.rotation ?? 0)} onChange={e => onChange({ rotation: Number(e.target.value) })} /></Row>
        <Row label="Opacity">
          <input type="range" min={0} max={100} value={pct(el.opacity ?? 1)} onChange={e => onChange({ opacity: Number(e.target.value) / 100 })} className="w-24" />
        </Row>
      </Section>

      {/* Type-specific */}
      {el.type === 'text' && (
        <Section title="Text">
          <textarea
            value={el.content}
            onChange={e => onChange({ content: e.target.value })}
            rows={2}
            className="w-full rounded-md border border-border bg-card p-2 text-[13px] text-foreground focus:border-primary/40 focus:outline-none"
          />
          {/* Visual variable picker — inserts a {{token}}; manual typing still works. */}
          <VariablePicker onInsert={token => onChange({ content: (el.content ?? '') + token })} />
          <Row label="Font">
            <select value={el.fontFamily} onChange={e => onChange({ fontFamily: e.target.value as FontFamily })} className="h-7 rounded-md border border-border bg-card px-2 text-[12px]">
              {FONT_FAMILIES.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </Row>
          <Row label="Size">
            <input type="number" className={numCls} value={Math.round(el.fontSizeFrac * canvas.height)}
              onChange={e => onChange({ fontSizeFrac: Math.max(1, Number(e.target.value)) / canvas.height })} />
          </Row>
          <Row label="Weight">
            <ToggleBtn active={el.weight === 'bold'} onClick={() => onChange({ weight: el.weight === 'bold' ? 'normal' : 'bold' })}>Bold</ToggleBtn>
            <ToggleBtn active={!!el.italic} onClick={() => onChange({ italic: !el.italic })}>Italic</ToggleBtn>
          </Row>
          <Row label="Align">
            {(['left', 'center', 'right'] as const).map(a => (
              <ToggleBtn key={a} active={el.align === a} onClick={() => onChange({ align: a })}>{a[0].toUpperCase()}</ToggleBtn>
            ))}
          </Row>
          <Row label="Color"><input type="color" value={el.color} onChange={e => onChange({ color: e.target.value })} className="h-7 w-10 rounded border border-border" /></Row>
        </Section>
      )}

      {el.type === 'image' && (
        <Section title="Image">
          {/* RD-CERT-PHOTO-01 — SOURCE decides where the bytes come from. Absent ⇒ static,
              so an element saved before this control existed lands on "Static Image".
              Switching to Attendee Photo clears assetUrl: keeping a stale URL on an
              element that ignores it would resurface if the organizer switched back. */}
          <Row label="Source">
            <ToggleBtn
              active={(el.source ?? 'static') === 'static'}
              onClick={() => onChange({ source: 'static' } as Partial<LayoutElement>)}
            >Static</ToggleBtn>
            <ToggleBtn
              active={el.source === 'attendeePhoto'}
              // `fit: 'contain'` is set in the SAME patch as the switch. An element that
              // was a static 'cover' image would otherwise carry cover into a source the
              // server rejects, and the very next autosave would fail with a 400.
              onClick={() => onChange({ source: 'attendeePhoto', assetUrl: '', fit: 'contain' } as Partial<LayoutElement>)}
            >Attendee Photo</ToggleBtn>
          </Row>

          {el.source === 'attendeePhoto' ? (
            <p className="mt-1 rounded-md bg-muted/40 p-2 text-[11px] leading-relaxed text-muted-foreground">
              Uses the attendee&apos;s uploaded photo when available. Attendees who have not
              uploaded one still receive their certificate — this box is simply left empty.
            </p>
          ) : (
            <>
              <label className={cn('flex cursor-pointer items-center justify-center gap-2 rounded-md border border-border bg-card py-2 text-[13px] font-medium text-foreground hover:bg-muted/40', uploading && 'opacity-60')}>
                {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
                {el.assetUrl ? 'Replace image' : 'Upload image'}
                <input type="file" accept="image/png,image/jpeg" className="hidden" disabled={uploading} onChange={onFile} />
              </label>
              <button type="button" onClick={() => setPickerOpen(true)} className="mt-1.5 flex w-full items-center justify-center gap-2 rounded-md border border-border bg-card py-2 text-[13px] font-medium text-foreground hover:bg-muted/40">
                <Images className="size-3.5" /> Choose from Library
              </button>
              <AssetPickerModal open={pickerOpen} onClose={() => setPickerOpen(false)} onPick={url => onChange({ assetUrl: url } as Partial<LayoutElement>)} />
            </>
          )}

          {/* FIT. Static images keep both options, exactly as before.
              An attendee photo is CONTAIN-only: pdf-lib cannot clip, so `cover` scales the
              image past its box and paints over whatever the organizer placed around it.
              A static asset is chosen by the organizer at a known aspect, so they can judge
              that; an attendee photo is an unknown crop of a stranger's camera roll, so the
              overflow is unpredictable. `contain` also costs nothing here — the attendee's
              crop is already baked into the stored image. */}
          {el.source === 'attendeePhoto' ? (
            <Row label="Fit">
              <ToggleBtn active onClick={() => onChange({ fit: 'contain' })}>contain</ToggleBtn>
              <span className="text-[11px] text-muted-foreground">fits inside the box</span>
            </Row>
          ) : (
            <Row label="Fit">
              {(['contain', 'cover'] as const).map(f => (
                <ToggleBtn key={f} active={el.fit === f} onClick={() => onChange({ fit: f })}>{f}</ToggleBtn>
              ))}
            </Row>
          )}
        </Section>
      )}

      {el.type === 'qr' && (
        <Section title="QR">
          <Row label="Color"><input type="color" value={el.darkColor ?? '#1a1a1a'} onChange={e => onChange({ darkColor: e.target.value })} className="h-7 w-10 rounded border border-border" /></Row>
          <p className="text-[11px] text-muted-foreground">Encodes the certificate verification URL.</p>
        </Section>
      )}

      {el.type === 'line' && (
        <Section title="Line">
          <Row label="Color"><input type="color" value={el.color} onChange={e => onChange({ color: e.target.value })} className="h-7 w-10 rounded border border-border" /></Row>
          <Row label="Thickness"><input type="number" className={numCls} value={Math.round(el.thickness * canvas.height)} onChange={e => onChange({ thickness: Math.max(1, Number(e.target.value)) / canvas.height })} /></Row>
        </Section>
      )}
    </PanelShell>
  )
}

function PanelShell({ children }: { children: React.ReactNode }) {
  return <div className="h-full overflow-y-auto p-4">{children}</div>
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">{title}</p>
      {children}
    </div>
  )
}

function ToggleBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={cn('h-7 min-w-7 rounded-md border px-2 text-[12px] font-medium', active ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-card text-foreground hover:bg-muted/40')}>
      {children}
    </button>
  )
}
