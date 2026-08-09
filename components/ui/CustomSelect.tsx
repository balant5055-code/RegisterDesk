'use client'

import { useState, useRef, useEffect, useId } from 'react'
import { ChevronDown, Check, Search } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

interface CustomSelectProps {
  id?:                 string
  value:               string
  options:             string[]
  placeholder?:        string
  disabled?:           boolean
  onChange:            (value: string) => void
  'aria-invalid'?:     boolean
  'aria-describedby'?: string
}

export function CustomSelect({
  id: idProp,
  value,
  options,
  placeholder = 'Select…',
  disabled = false,
  onChange,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedby,
}: CustomSelectProps) {
  const generatedId = useId()
  const id          = idProp ?? generatedId

  const [open,        setOpen]        = useState(false)
  const [query,       setQuery]       = useState('')
  const [highlighted, setHighlighted] = useState(-1)

  // RD-RT3.2.2 BUG 2 (cause B): the panel was hard-coded to open downward with a fixed
  // max-height, so near the bottom of the viewport it ran past the fold. It now measures
  // the space actually available and flips up — or shrinks — to stay fully on screen.
  const [placement, setPlacement] = useState<'down' | 'up'>('down')
  const [maxHeight, setMaxHeight] = useState<number | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const searchRef    = useRef<HTMLInputElement>(null)
  const listRef      = useRef<HTMLUListElement>(null)

  const showSearch = options.length > 6
  const filtered   = showSearch
    ? options.filter(o => o.toLowerCase().includes(query.toLowerCase()))
    : options

  useEffect(() => {
    if (!open) { setQuery(''); return }
    if (showSearch) setTimeout(() => searchRef.current?.focus(), 0)
    const idx = filtered.indexOf(value)
    setHighlighted(idx >= 0 ? idx : 0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Collision detection — native measurement, no positioning library and no portal.
  // Runs on open and keeps up with scroll/resize while open, so a list opened mid-page
  // stays correct if the page moves under it.
  useEffect(() => {
    if (!open) return

    function place() {
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      const GAP = 8
      const below = window.innerHeight - rect.bottom - GAP
      const above = rect.top - GAP
      // Flip only when there is genuinely more room above — never flip into less space.
      const up = below < 220 && above > below
      setPlacement(up ? 'up' : 'down')
      // Never taller than the space available, never so short it is unusable.
      setMaxHeight(Math.max(140, Math.min(320, up ? above : below)))
    }

    // rAF-deferred: this repo's `react-hooks/set-state-in-effect` rule forbids setting
    // state synchronously in an effect body.
    const raf = requestAnimationFrame(place)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [open])

  useEffect(() => {
    if (!open || highlighted < 0) return
    const item = listRef.current?.children[highlighted] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  }, [highlighted, open])

  function navigate(e: React.KeyboardEvent) {
    if (e.key === 'Escape')     { setOpen(false); return }
    if (e.key === 'ArrowDown')  { e.preventDefault(); setHighlighted(h => Math.min(h + 1, filtered.length - 1)); return }
    if (e.key === 'ArrowUp')    { e.preventDefault(); setHighlighted(h => Math.max(h - 1, 0)); return }
    if (e.key === 'Enter') {
      e.preventDefault()
      const opt = filtered[highlighted]
      if (opt !== undefined) { onChange(opt); setOpen(false) }
    }
  }

  function handleTriggerKey(e: React.KeyboardEvent) {
    if (disabled) return
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); setOpen(true) }
      return
    }
    navigate(e)
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedby}
        disabled={disabled}
        onClick={() => !disabled && setOpen(o => !o)}
        onKeyDown={handleTriggerKey}
        className={cn(
          'flex h-[var(--select-height)] w-full items-center justify-between rounded-xl border bg-background px-[var(--select-px)] text-[13.5px] text-left outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-50',
          open
            ? 'border-primary/60 ring-2 ring-primary/20'
            : 'border-border hover:border-muted-foreground/40',
          ariaInvalid && !open && 'border-destructive/60',
        )}
      >
        <span className={value ? 'text-foreground' : 'text-muted-foreground/50'}>
          {value || placeholder}
        </span>
        <ChevronDown
          className={cn('ml-2 size-4 shrink-0 text-muted-foreground transition-transform duration-200', open && 'rotate-180')}
          aria-hidden
        />
      </button>

      {open && (
        <div
          className={cn(
            "absolute left-0 right-0 z-50 flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-lg",
            placement === "up" ? "bottom-[calc(100%+4px)]" : "top-[calc(100%+4px)]",
          )}
        >
          {showSearch && (
            <div className="border-b border-border/50 px-2 py-2">
              <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5">
                <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={e => { setQuery(e.target.value); setHighlighted(0) }}
                  onKeyDown={navigate}
                  placeholder="Search…"
                  className="flex-1 bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground/50 outline-none"
                  aria-label="Search options"
                />
              </div>
            </div>
          )}
          <ul
            ref={listRef}
            role="listbox"
            aria-label="Options"
            className="overflow-y-auto py-1"
            style={{ maxHeight: maxHeight ?? 208 }}
          >
            {filtered.length === 0 ? (
              <li className="px-3.5 py-2.5 text-[13px] text-muted-foreground">No results</li>
            ) : (
              filtered.map((opt, i) => (
                <li
                  key={opt}
                  role="option"
                  aria-selected={opt === value}
                  onClick={() => { onChange(opt); setOpen(false) }}
                  onMouseEnter={() => setHighlighted(i)}
                  className={cn(
                    'flex cursor-pointer items-center justify-between px-3.5 py-2.5 text-[13px] transition-colors',
                    i === highlighted
                      ? 'bg-primary/[0.06] text-primary'
                      : 'text-foreground hover:bg-muted/60',
                  )}
                >
                  {opt}
                  {opt === value && <Check className="size-3.5 shrink-0 text-primary" aria-hidden />}
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  )
}
