import { cn } from '@/lib/utils/cn'

// ─── FilterTabs ─────────────────────────────────────────────────────────────────
// The bordered segmented control used for status / scope filtering on admin lists.
// Generic over the option value so pages keep their own union types.

export interface FilterTabOption<T> {
  value: T
  label: string
}

export interface FilterTabsProps<T> {
  options:   ReadonlyArray<FilterTabOption<T>>
  value:     T
  onChange:  (value: T) => void
  className?: string
  'aria-label'?: string
}

export function FilterTabs<T extends string | number>({
  options,
  value,
  onChange,
  className,
  'aria-label': ariaLabel,
}: FilterTabsProps<T>) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn('flex items-center gap-1 rounded-lg border border-border bg-card p-1', className)}
    >
      {options.map(o => {
        const active = value === o.value
        return (
          <button
            key={String(o.value)}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={cn(
              'rounded-md px-3 py-1 text-[13px] font-medium transition-colors',
              active ? 'bg-primary/[0.08] text-primary' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
