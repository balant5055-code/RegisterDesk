'use client'

import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { ReactNode } from 'react'
import { SectionWrapper } from '@/components/event-templates/shared/ui/SectionWrapper'
import { parseMarkdownBlocks, RichBlocks } from '@/components/event-templates/shared/ui/RichText'

export function AboutSection({ description, highlights }: {
  description: string
  highlights?: { icon: ReactNode; label: string }[]
}) {
  const [expanded, setExpanded] = useState(false)
  // RD-MARKDOWN-01 — Markdown blocks (shared/ui/RichText); "Read more" still folds after four.
  const blocks  = parseMarkdownBlocks(description)
  const isLong  = blocks.length > 4
  const visible = isLong && !expanded ? blocks.slice(0, 4) : blocks

  return (
    <SectionWrapper title="About This Event">
      <div className="space-y-3">
        <RichBlocks blocks={visible} className="space-y-3 text-sm leading-relaxed text-muted-foreground" />
        {isLong && (
          <button
            onClick={() => setExpanded(e => !e)}
            className="flex items-center gap-1 text-xs font-semibold text-action hover:underline"
          >
            {expanded
              ? <><ChevronUp className="size-3.5" aria-hidden />Show less</>
              : <><ChevronDown className="size-3.5" aria-hidden />Read more</>}
          </button>
        )}
      </div>

      {highlights && highlights.length > 0 && (
        <div className="mt-3.5 flex flex-wrap gap-1.5">
          {highlights.map(({ icon, label }) => (
            <div
              key={label}
              className="flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/20 px-3 py-1 text-[10.5px] font-medium text-foreground"
            >
              <span className="text-action">{icon}</span>
              {label}
            </div>
          ))}
        </div>
      )}
    </SectionWrapper>
  )
}
