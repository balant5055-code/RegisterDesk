'use client'

// FAQShowcase — a premium, reusable FAQ. Pure and shared by every template.
//
// 100% data-driven from `faq[]`: only enabled items with a question+answer render;
// every optional field appears only when present; zero items → the section returns
// null. Auto-groups by category (with a sticky jump index on desktop), shows a search
// box past 8 items, supports deep-linking (#faq-<category> / #faq-item-<id>), and is
// collapsed by default (only a deep-linked or featured item auto-opens). ARIA
// accordion with arrow-key navigation. `legacyFaqToItems` adapts old {question,answer}
// arrays so existing events keep working.

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { ChevronDown, Search, ArrowRight, Clock, Users, X } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { FaqItem } from '@/components/wizard/eventDetailsConfig'
import { SectionShell, SectionHeader, CARD, EASE, AttachmentChips } from '@/components/event-templates/shared/ui/framework'

const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

// ── temporary legacy adapter ──
export function legacyFaqToItems(faqs: { question: string; answer: string }[] | undefined): FaqItem[] {
  return (faqs ?? [])
    .filter(f => f?.question?.trim() && f?.answer?.trim())
    .map((f, i) => ({ id: `faq_${i}`, question: f.question.trim(), answer: f.answer.trim(), enabled: true }))
}

// ── one accordion row ──
function FaqRow({
  item, open, onToggle, reduce, onRelated,
}: {
  item: FaqItem; open: boolean; onToggle: () => void; reduce: boolean | null
  onRelated: (id: string) => void
}) {
  const panelId = `faq-panel-${item.id}`
  const btnId   = `faq-btn-${item.id}`
  return (
    <div id={`faq-item-${item.id}`} className="scroll-mt-28 border-b border-border/50 last:border-0">
      <h4>
        <button
          id={btnId}
          type="button"
          data-faq-btn
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
          className="flex w-full items-center gap-3 py-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2"
        >
          <span className="flex-1 text-[15.5px] font-semibold leading-snug text-foreground">
            {item.question}
            {item.audience?.trim() && (
              <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 align-middle text-[10.5px] font-medium text-muted-foreground">
                <Users className="size-3" aria-hidden />{item.audience}
              </span>
            )}
          </span>
          <ChevronDown className={cn('size-5 shrink-0 text-muted-foreground transition-transform duration-200', open && 'rotate-180', reduce && 'transition-none')} aria-hidden />
        </button>
      </h4>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={panelId}
            role="region"
            aria-labelledby={btnId}
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduce ? undefined : { height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="pb-5 pr-8">
              <p className="whitespace-pre-line text-[14px] leading-relaxed text-muted-foreground">{item.answer}</p>

              <AttachmentChips attachments={item.attachments} links={item.links} className="mt-3" />

              {item.relatedFaqs && item.relatedFaqs.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground/70">Related</span>
                  {item.relatedFaqs.filter(Boolean).map(rid => (
                    <button key={rid} type="button" onClick={() => onRelated(rid)}
                      className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-[12px] font-semibold text-primary hover:bg-primary/15">
                      {rid}<ArrowRight className="size-3" aria-hidden />
                    </button>
                  ))}
                </div>
              )}

              {item.updatedAt?.trim() && (
                <p className="mt-3 inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground/70">
                  <Clock className="size-3.5" aria-hidden />Updated {item.updatedAt}
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── section ──
export interface FAQShowcaseProps {
  items:        FaqItem[]
  eyebrow?:     string
  title?:       string
  subtitle?:    string
  contactHref?: string
  contactLabel?:string
}

export function FAQShowcase({
  items, eyebrow = 'FAQ', title = 'Questions & Answers', subtitle,
  contactHref, contactLabel = 'Contact Organizer',
}: FAQShowcaseProps) {
  const reduce = useReducedMotion()
  const rootRef = useRef<HTMLDivElement>(null)

  const all = useMemo(() => (items ?? [])
    .filter(i => i && i.enabled !== false && i.question?.trim() && i.answer?.trim())
    .sort((a, b) => (a.displayOrder ?? a.priority ?? 0) - (b.displayOrder ?? b.priority ?? 0)),
    [items])

  // collapsed by default; only a featured item auto-opens (deep-link handled below)
  const [openId, setOpenId] = useState<string | null>(() => all.find(i => i.featured)?.id ?? null)
  const [query, setQuery] = useState('')

  const openItem = (id: string) => {
    setOpenId(id)
    if (typeof window !== 'undefined') {
      history.replaceState(null, '', `#faq-item-${id}`)
      requestAnimationFrame(() => document.getElementById(`faq-item-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
    }
  }

  // deep-linking (deferred setState so it isn't a synchronous effect body call)
  useEffect(() => {
    const apply = () => {
      const raw = window.location.hash.replace(/^#/, '')
      if (!raw) return
      let target: FaqItem | undefined
      if (raw.startsWith('faq-item-')) target = all.find(i => i.id === raw.slice('faq-item-'.length))
      else if (raw.startsWith('faq-')) {
        const key = raw.slice('faq-'.length)
        target = all.find(i => i.category && slug(i.category) === key) ?? all.find(i => i.id === key)
      } else target = all.find(i => i.id === raw)
      if (target) {
        setOpenId(target.id)
        requestAnimationFrame(() => document.getElementById(`faq-item-${target!.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
      }
    }
    const id = window.setTimeout(apply, 0)
    window.addEventListener('hashchange', apply)
    return () => { clearTimeout(id); window.removeEventListener('hashchange', apply) }
  }, [all])

  if (all.length === 0) return null

  const showSearch = all.length > 8
  const searching  = showSearch && query.trim().length > 0
  const q = query.trim().toLowerCase()
  const filtered = searching
    ? all.filter(i => i.question.toLowerCase().includes(q) || i.answer.toLowerCase().includes(q))
    : all

  // group by category (suspended while searching)
  const grouped = !searching && all.some(i => i.category?.trim())
  const groups: { category: string | null; items: FaqItem[] }[] = []
  if (grouped) {
    const order: string[] = []
    const map = new Map<string, FaqItem[]>()
    for (const it of filtered) {
      const c = it.category?.trim() || 'More'
      if (!map.has(c)) { map.set(c, []); order.push(c) }
      map.get(c)!.push(it)
    }
    for (const c of order) groups.push({ category: c, items: map.get(c)! })
  } else {
    groups.push({ category: null, items: filtered })
  }

  const onKeyNav = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    const btns = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('[data-faq-btn]') ?? [])
    const idx = btns.indexOf(document.activeElement as HTMLButtonElement)
    if (idx === -1) return
    e.preventDefault()
    const to = e.key === 'ArrowDown' ? (idx + 1) % btns.length
      : e.key === 'ArrowUp' ? (idx - 1 + btns.length) % btns.length
        : e.key === 'Home' ? 0 : btns.length - 1
    btns[to]?.focus()
  }

  const accordion = (list: FaqItem[]) => (
    <div className={cn(CARD, 'px-5 sm:px-6')}>
      {list.map(item => (
        <FaqRow
          key={item.id}
          item={item}
          open={openId === item.id}
          onToggle={() => (openId === item.id ? setOpenId(null) : openItem(item.id))}
          onRelated={openItem}
          reduce={reduce}
        />
      ))}
    </div>
  )

  const body = grouped ? (
    <div className="grid gap-8 lg:grid-cols-[196px_1fr]">
      {/* sticky category index (desktop) */}
      <nav aria-label="FAQ categories" className="hidden lg:block">
        <div className="sticky top-24 flex flex-col gap-1">
          {groups.map(g => (
            <a key={g.category} href={`#faq-${slug(g.category!)}`}
              className="rounded-lg px-3 py-2 text-[13px] font-semibold text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground">
              {g.category}
            </a>
          ))}
        </div>
      </nav>
      <div className="flex flex-col gap-8">
        {groups.map(g => (
          <div key={g.category} id={`faq-${slug(g.category!)}`} className="scroll-mt-24">
            <h3 className="mb-3 text-[14px] font-bold uppercase tracking-[0.12em] text-foreground">{g.category}</h3>
            {accordion(g.items)}
          </div>
        ))}
      </div>
    </div>
  ) : (
    <div className="mx-auto max-w-3xl">
      {filtered.length === 0
        ? <p className="rounded-2xl border border-border/50 bg-card px-6 py-10 text-center text-[14px] text-muted-foreground shadow-sm">No questions match “{query}”.</p>
        : accordion(filtered)}
    </div>
  )

  return (
    <SectionShell id="faq" maxW="5xl" innerRef={rootRef} onKeyDown={onKeyNav}>

        <SectionHeader eyebrow={eyebrow} title={title} subtitle={subtitle} />

        {showSearch && (
          <div className="relative mb-6 max-w-md">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/50" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search questions…"
              aria-label="Search questions"
              className="h-11 w-full rounded-xl border border-border/70 bg-muted/15 pl-10 pr-9 text-[14px] text-foreground outline-none transition-all placeholder:text-muted-foreground/50 focus:border-primary/40 focus:bg-white focus:ring-2 focus:ring-primary/10"
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} aria-label="Clear search"
                className="absolute right-2.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground/50 hover:bg-muted hover:text-foreground">
                <X className="size-4" aria-hidden />
              </button>
            )}
          </div>
        )}

        {body}

        {contactHref?.trim() && (
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3 text-center">
            <span className="text-[14px] text-muted-foreground">Still have questions?</span>
            <Link href={contactHref} className="inline-flex items-center gap-1.5 text-[14px] font-semibold text-primary hover:underline">
              {contactLabel}<ArrowRight className="size-4" aria-hidden />
            </Link>
          </div>
        )}
    </SectionShell>
  )
}
