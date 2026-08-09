'use client'

// RD-LAUNCH-06 — Support Centre search.
//
// The brief allowed a UI-only search box because no search backend exists. A box that
// accepts typing and does nothing is still fake functionality from the user's side, so
// this filters the real help content instead: the 18 factual answers already in
// content/marketing/faq.ts, matched client-side.
//
// No backend, no index, no network — and no pretence. The whole corpus is already on
// the page, so filtering it is honest and instant.
//
// This is the ONLY client component on the Support Centre; every other section is a
// Server Component.

import { useMemo, useState, useId } from 'react'
import Link from 'next/link'
import { Search, X } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { FaqItem } from '@/lib/marketing/types'

export function SupportSearch({ items }: { items: FaqItem[] }) {
  const [query, setQuery] = useState('')
  const inputId  = useId()
  const statusId = useId()

  const trimmed = query.trim().toLowerCase()

  const results = useMemo(() => {
    if (trimmed.length < 2) return []
    return items.filter(i =>
      i.question.toLowerCase().includes(trimmed) ||
      i.answer.toLowerCase().includes(trimmed),
    )
  }, [items, trimmed])

  const searching = trimmed.length >= 2

  return (
    <div className="mx-auto w-full max-w-2xl">
      <label htmlFor={inputId} className="sr-only">Search help topics</label>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          id={inputId}
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search help topics…"
          autoComplete="off"
          aria-describedby={statusId}
          className="h-12 w-full rounded-xl border border-border bg-white pl-11 pr-11 text-[14px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 hover:border-border/70 focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label="Clear search"
            className="absolute right-3 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/50"
          >
            <X className="size-4" aria-hidden />
          </button>
        )}
      </div>

      {/* Result count is announced, so a screen-reader user learns the outcome of
          typing without having to explore the list. */}
      <p id={statusId} aria-live="polite" className="mt-2 min-h-5 text-[12.5px] text-muted-foreground">
        {searching
          ? results.length === 0
            ? 'No matching answers. Try a different word, or contact support below.'
            : `${results.length} matching ${results.length === 1 ? 'answer' : 'answers'}`
          : ''}
      </p>

      {searching && results.length > 0 && (
        <ul className="mt-3 divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-white text-left">
          {results.map(r => (
            <li key={r.question} className="px-5 py-4">
              <p className="text-[14px] font-semibold text-foreground">{r.question}</p>
              <p className="mt-1 text-[13.5px] leading-relaxed text-muted-foreground">{r.answer}</p>
              {r.href && (
                <Link
                  href={r.href}
                  className={cn(
                    'mt-2 inline-block rounded text-[13px] font-semibold text-primary underline-offset-2',
                    'outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2',
                  )}
                >
                  Read more
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
