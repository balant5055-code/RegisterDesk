'use client'

import {
  ArrowUp, ArrowDown, Copy, Lock, Unlock, Eye, EyeOff, Trash2,
  Type, ImageIcon, QrCode, Minus,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { EditorMeta } from './lib'
import type { LayoutElement } from '@/lib/certificates/types'

interface Props {
  elements:    LayoutElement[]
  meta:        Record<string, EditorMeta>
  selectedIds: string[]
  select:      (id: string, additive: boolean) => void
  bringForward:  (id: string) => void
  sendBackward:  (id: string) => void
  duplicate:   (id: string) => void
  toggleLock:  (id: string) => void
  toggleHide:  (id: string) => void
  remove:      (id: string) => void
}

function iconFor(el: LayoutElement) {
  if (el.type === 'text') return Type
  if (el.type === 'image') return ImageIcon
  if (el.type === 'qr') return QrCode
  return Minus
}

function labelFor(el: LayoutElement): string {
  if (el.type === 'text') return el.content.slice(0, 28) || 'Text'
  if (el.type === 'image') return (el.role ?? 'image').replace(/^\w/, c => c.toUpperCase())
  if (el.type === 'qr') return 'QR Code'
  return 'Line'
}

export default function LayersPanel(p: Props) {
  // Top of the list = top of the stack (highest zIndex).
  const ordered = [...p.elements].sort((a, b) => b.zIndex - a.zIndex)

  return (
    <div className="h-full overflow-y-auto">
      {ordered.length === 0 && (
        <p className="px-4 py-3 text-[12px] text-muted-foreground">No elements yet. Add some from the palette.</p>
      )}
      {ordered.map(el => {
        const Icon = iconFor(el)
        const sel = p.selectedIds.includes(el.id)
        const m = p.meta[el.id]
        return (
          <div
            key={el.id}
            onClick={e => p.select(el.id, e.shiftKey)}
            className={cn('flex cursor-pointer items-center gap-2 border-b border-border px-3 py-2', sel ? 'bg-primary/[0.06]' : 'hover:bg-muted/30')}
          >
            <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className={cn('flex-1 truncate text-[12px]', m?.hidden ? 'text-muted-foreground/50 line-through' : 'text-foreground')}>{labelFor(el)}</span>
            <div className="flex items-center gap-0.5">
              <IconBtn title="Bring forward" onClick={e => { e.stopPropagation(); p.bringForward(el.id) }}><ArrowUp className="size-3.5" /></IconBtn>
              <IconBtn title="Send backward" onClick={e => { e.stopPropagation(); p.sendBackward(el.id) }}><ArrowDown className="size-3.5" /></IconBtn>
              <IconBtn title="Duplicate" onClick={e => { e.stopPropagation(); p.duplicate(el.id) }}><Copy className="size-3.5" /></IconBtn>
              <IconBtn title={m?.locked ? 'Unlock' : 'Lock'} onClick={e => { e.stopPropagation(); p.toggleLock(el.id) }}>{m?.locked ? <Lock className="size-3.5" /> : <Unlock className="size-3.5" />}</IconBtn>
              <IconBtn title={m?.hidden ? 'Show' : 'Hide'} onClick={e => { e.stopPropagation(); p.toggleHide(el.id) }}>{m?.hidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}</IconBtn>
              <IconBtn title="Delete" danger onClick={e => { e.stopPropagation(); p.remove(el.id) }}><Trash2 className="size-3.5" /></IconBtn>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function IconBtn({ title, onClick, danger, children }: { title: string; onClick: (e: React.MouseEvent) => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn('flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted', danger && 'hover:bg-red-50 hover:text-red-600')}
    >
      {children}
    </button>
  )
}
