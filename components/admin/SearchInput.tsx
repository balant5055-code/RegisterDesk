import { Search } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

// ─── SearchInput ────────────────────────────────────────────────────────────────
// The standard admin search field: leading Search icon + bordered input. Width is
// left to the caller (pass `className`, e.g. "max-w-xs flex-1").

export interface SearchInputProps {
  value:        string
  onChange:     (value: string) => void
  placeholder?: string
  className?:   string
  'aria-label'?: string
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
  className,
  'aria-label': ariaLabel,
}: SearchInputProps) {
  return (
    <div className={cn('relative', className)}>
      <Search
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        className="w-full rounded-lg border border-border bg-card py-2 pl-9 pr-3 text-[13.5px] outline-none focus:border-primary"
      />
    </div>
  )
}
