'use client'

import { CheckCircle2, ExternalLink, Headphones, Sparkles } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import Link from 'next/link'
import { cn } from '@/lib/utils/cn'
import { buttonVariants } from '@/components/ui'
import { getTemplate, type TemplateDefinition } from '@/lib/events/templateRegistry'

// ─── Constants ─────────────────────────────────────────────────────────────────

const BENEFITS = [
  'Get a pre-built registration form',
  'Recommended ticket types',
  'Smart features for your event',
  'Better attendee experience',
] as const

const EASE = [0.22, 1, 0.36, 1] as const

// ─── Template mockup preview ───────────────────────────────────────────────────

function TemplateMockup({ template }: { template: TemplateDefinition }) {
  return (
    <div className="w-full overflow-hidden">
      {/* Browser chrome */}
      <div className="flex h-6 items-center gap-1.5 bg-[#F5F6F8] px-3">
        <span className="size-[6px] rounded-full bg-[#FF6B6B]/60" aria-hidden />
        <span className="size-[6px] rounded-full bg-[#FFD93D]/60" aria-hidden />
        <span className="size-[6px] rounded-full bg-[#6BCB77]/60" aria-hidden />
        <div className="ml-2 h-3 flex-1 rounded-full bg-[#E8EAED]" aria-hidden />
      </div>

      {/* Page mockup */}
      <div className="relative bg-white" style={{ height: 148 }}>

        {/* Hero strip */}
        <div
          className="flex h-[68px] flex-col justify-end px-3.5 pb-2.5"
          style={{ background: `linear-gradient(135deg, ${template.accentColor}22 0%, ${template.accentColor}06 100%)` }}
        >
          <div className="h-[9px] w-28 rounded-sm" style={{ backgroundColor: `${template.accentColor}45` }} />
          <div className="mt-1 h-[6px] w-16 rounded-sm bg-[#E8EAED]" />
        </div>

        {/* Content rows */}
        <div className="flex items-start gap-2.5 px-3.5 pt-3">
          <div className="flex-1 space-y-1.5">
            <div className="h-[5px] rounded-sm bg-[#E8EAED]" />
            <div className="h-[5px] w-5/6 rounded-sm bg-[#F0F2F5]" />
            <div className="h-[5px] w-2/3 rounded-sm bg-[#F0F2F5]" />
          </div>
          <div
            className="h-14 w-14 shrink-0 rounded-lg"
            style={{ background: `${template.accentColor}12`, border: `1px solid ${template.accentColor}18` }}
          />
        </div>

        {/* Pill chips row */}
        <div className="mt-2.5 flex gap-1.5 px-3.5">
          {template.keyFeatures.slice(0, 3).map(f => (
            <span
              key={f}
              className="rounded-full px-2 py-[2px] text-[8px] font-medium"
              style={{ backgroundColor: `${template.accentColor}10`, color: template.accentColor }}
            >
              {f.split(' ')[0]}
            </span>
          ))}
        </div>

        {/* CTA bar */}
        <div className="mt-2.5 flex items-center gap-2 px-3.5">
          <div
            className="h-[22px] w-20 rounded-md"
            style={{ backgroundColor: `${template.accentColor}20` }}
          />
          <div className="h-[22px] w-14 rounded-md bg-[#F0F2F5]" />
        </div>

        {/* Preview label */}
        <span className="absolute bottom-1.5 right-2 text-[8px] font-medium text-black/15">
          Preview
        </span>
      </div>
    </div>
  )
}

// ─── Default panel (no category selected) ─────────────────────────────────────

function DefaultPanel() {
  return (
    <aside
      aria-label="Event creation help"
      className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_4px_rgba(0,0,0,0.05)]"
    >
      {/* Top section */}
      <div className="px-5 py-4">
        <div className="mb-2 flex items-center gap-2">
          <Sparkles className="size-[14px] shrink-0 text-primary" aria-hidden />
          <p className="text-[12.5px] font-semibold text-foreground">
            Not sure which type to pick?
          </p>
        </div>
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Choose the closest match. Use &ldquo;Custom Event&rdquo; to build a fully custom experience from scratch.
        </p>
      </div>

      <div className="mx-5 border-t border-border" />

      {/* Help section */}
      <div className="px-5 py-4">
        <div className="mb-2 flex items-center gap-2">
          <Headphones className="size-[14px] shrink-0 text-muted-foreground" aria-hidden />
          <p className="text-[12.5px] font-semibold text-foreground">Need Help?</p>
        </div>
        <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground">
          We&apos;re here to help you create the perfect event.
        </p>
        <Link
          href="#"
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'w-full justify-center text-[12.5px] hover:bg-muted')}
          aria-label="View help guide"
        >
          View Help Guide
          <ExternalLink className="ml-1.5 size-3" aria-hidden />
        </Link>
      </div>

      <div className="mx-5 border-t border-border" />

      {/* Benefits section */}
      <div className="px-5 py-4">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/50">
          Why it matters
        </p>
        <ul className="space-y-2.5" aria-label="Benefits">
          {BENEFITS.map(benefit => (
            <li key={benefit} className="flex items-start gap-2.5">
              <CheckCircle2 className="mt-px size-3.5 shrink-0 text-primary" aria-hidden />
              <span className="text-[12px] leading-snug text-muted-foreground">{benefit}</span>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  )
}

// ─── Template preview panel ────────────────────────────────────────────────────

export function TemplatePreviewPanel({ selectedTypeId }: { selectedTypeId: string | null }) {
  const template = selectedTypeId ? getTemplate(selectedTypeId) : undefined

  if (!template) {
    return (
      <AnimatePresence mode="wait">
        <motion.div
          key="default"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.2, ease: EASE }}
        >
          <DefaultPanel />
        </motion.div>
      </AnimatePresence>
    )
  }

  const Icon = template.icon

  return (
    <AnimatePresence mode="wait">
      <motion.aside
        key={template.id}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.22, ease: EASE }}
        aria-label={`${template.name} template preview`}
        className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_4px_rgba(0,0,0,0.05)]"
      >
        {/* Accent top bar */}
        <div className="h-[3px] w-full" style={{ backgroundColor: template.accentColor }} />

        {/* Header */}
        <div
          className="px-5 py-4"
          style={{ backgroundColor: `${template.accentColor}08` }}
        >
          <div className="flex items-center gap-3">
            <div
              className="flex size-8 shrink-0 items-center justify-center rounded-lg"
              style={{ backgroundColor: `${template.accentColor}18` }}
              aria-hidden
            >
              <Icon className="size-[15px]" style={{ color: template.accentColor }} />
            </div>
            <div className="min-w-0">
              <p
                className="text-[10px] font-semibold uppercase tracking-[0.14em]"
                style={{ color: template.accentColor }}
              >
                Template
              </p>
              <p className="truncate text-[13px] font-semibold text-foreground">{template.name}</p>
            </div>
          </div>
          <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
            {template.description}
          </p>
        </div>

        {/* Mockup preview */}
        <div className="border-b border-t border-border">
          <TemplateMockup template={template} />
        </div>

        {/* Best For */}
        <div className="px-5 py-3.5">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground/50">
            Best For
          </p>
          <ul className="space-y-1.5">
            {template.bestFor.map(item => (
              <li key={item} className="flex items-center gap-2">
                <span
                  className="size-[5px] shrink-0 rounded-full"
                  style={{ backgroundColor: template.accentColor }}
                  aria-hidden
                />
                <span className="text-[12px] text-muted-foreground">{item}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="border-t border-border" />

        {/* Key Features */}
        <div className="px-5 py-3.5">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground/50">
            Key Features
          </p>
          <ul className="space-y-1.5">
            {template.keyFeatures.map(feature => (
              <li key={feature} className="flex items-center gap-2">
                <CheckCircle2
                  className="size-[13px] shrink-0"
                  style={{ color: template.accentColor }}
                  aria-hidden
                />
                <span className="text-[12px] text-muted-foreground">{feature}</span>
              </li>
            ))}
          </ul>
        </div>
      </motion.aside>
    </AnimatePresence>
  )
}
