'use client'

import {
  Type, User, CalendarDays, Hash, CalendarClock,
  QrCode, ImageIcon, PenTool, Stamp, Image as ImgIcon, Minus,
} from 'lucide-react'
import { PALETTE_LABELS } from './lib'
import type { PaletteKind } from './lib'

const GROUPS: { title: string; items: { kind: PaletteKind; icon: React.ElementType }[] }[] = [
  {
    title: 'Text & Fields',
    items: [
      { kind: 'text',            icon: Type },
      { kind: 'participantName', icon: User },
      { kind: 'eventName',       icon: CalendarDays },
      { kind: 'eventDate',       icon: CalendarDays },
      { kind: 'certificateId',   icon: Hash },
      { kind: 'issueDate',       icon: CalendarClock },
    ],
  },
  {
    title: 'Media',
    items: [
      { kind: 'qr',        icon: QrCode },
      { kind: 'logo',      icon: ImageIcon },
      { kind: 'signature', icon: PenTool },
      { kind: 'seal',      icon: Stamp },
      { kind: 'image',     icon: ImgIcon },
    ],
  },
  {
    title: 'Shapes',
    items: [{ kind: 'line', icon: Minus }],
  },
]

export default function ElementPalette({ onAdd }: { onAdd: (kind: PaletteKind) => void }) {
  return (
    <div className="h-full overflow-y-auto p-3">
      {GROUPS.map(group => (
        <div key={group.title} className="mb-4">
          <p className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">{group.title}</p>
          <div className="grid grid-cols-2 gap-2">
            {group.items.map(({ kind, icon: Icon }) => (
              <button
                key={kind}
                type="button"
                onClick={() => onAdd(kind)}
                className="flex flex-col items-center gap-1.5 rounded-lg border border-border bg-card px-2 py-3 text-center transition-colors hover:border-primary/40 hover:bg-primary/[0.04]"
              >
                <Icon className="size-4 text-foreground/70" aria-hidden />
                <span className="text-[11px] font-medium leading-tight text-foreground">{PALETTE_LABELS[kind]}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
