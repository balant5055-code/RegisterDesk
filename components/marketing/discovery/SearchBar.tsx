'use client'

// Shared discovery search input (events + causes). Presentation only — the query
// value and handler live in the page. Canonical style converged from the /events
// filter search: h-10 pill, muted field, brand focus ring, inline clear button
// (clearing refocuses the field).

import { useRef } from 'react'
import { Search, X } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

export function SearchBar({
  value,
  onChange,
  placeholder = 'Search…',
  className,
}: {
  value:        string
  onChange:     (value: string) => void
  placeholder?: string
  className?:   string
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-3.5 top-1/2 size-[15px] -translate-y-1/2 text-muted-foreground/45" aria-hidden />
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className={cn(
          'h-10 w-full rounded-xl border border-border/70 bg-muted/15 pl-10 text-[13.5px] text-foreground',
          'placeholder:text-muted-foreground/40 outline-none transition-all',
          'focus:border-primary/40 focus:bg-white focus:ring-2 focus:ring-primary/8 focus:shadow-sm',
          value ? 'pr-8' : 'pr-4',
        )}
      />
      {value && (
        <button
          type="button"
          onClick={() => { onChange(''); inputRef.current?.focus() }}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 flex size-5 cursor-pointer items-center justify-center rounded-full text-muted-foreground/45 transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Clear search"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}
