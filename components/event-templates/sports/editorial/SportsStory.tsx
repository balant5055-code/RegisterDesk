// ─── SportsStory — why the race exists, set as a feature ────────────────────
//
// SPORTS-ONLY Server Component. The copy is the organiser's `description` field and
// nothing else; `parseStory` (storyModel.ts) READS the structure they already wrote
// into it — parts, entries, a closing statement — and this file composes it:
//
//   ┌ 4/12 ────────────────┬ 8/12 ───────────────────────────────────────────┐
//   │ OUR STORY            │  PART 01 · KEY OBJECTIVES ───────────────────    │
//   │ More Than a Marathon │  01 Restoration of Waterways                     │
//   │ (sticky on desktop)  │     body …                  02 Creating Public … │
//   │ Conducted in Tamil.  │  PART 02 · KEY HIGHLIGHTS ────────────────────    │
//   └──────────────────────┤  …                                               │
//                          │  ▍ the organiser's own closing statement, large  │
//                          └──────────────────────────────────────────────────┘
//
// The old section was the raw field in a max-w-3xl column: 1192px of unbroken text
// with the organiser's emoji doing all the structural work. Here the emoji stays as a
// small marker (it is their content), the headings become the page's own hierarchy,
// and the conclusion becomes the pull quote it always was.
//
// When an event's description carries no structure, `parseStory` says so and this
// renders flowing prose in a reading measure — the honest fallback, no imposed shape.

import { cn } from '@/lib/utils/cn'
import { BODY, FIELD, INDEX, SectionHead, SportsSection, idx, ITEM } from './primitives'
import { parseStory } from './storyModel'

export interface SportsStoryProps {
  description: string
  /** "Conducted in Tamil." — resolved by the template, rendered as the colophon. */
  languageNote?: string
  eyebrow?:      string
  title?:        string
}

export function SportsStory({ description, languageNote, eyebrow = 'Our Story', title = 'About the Event' }: SportsStoryProps) {
  const story = parseStory(description)
  if (story.groups.length === 0 && !story.closing) return null

  return (
    <SportsSection id="story">
      <SectionHead eyebrow={eyebrow} title={title} />

      {/* One column: the story sits in the page's reading column beside the sticky
          venue/kit rail, so its closing statement follows it rather than a side rail. */}
      <div className="mt-10">
        <div className="min-w-0">
          {story.plain ? (
            <div className="max-w-[68ch] space-y-4">
              {story.groups[0].entries[0].body.map(p => (
                <p key={p.slice(0, 40)} className={cn('whitespace-pre-line', BODY)}>{p}</p>
              ))}
            </div>
          ) : (
            story.groups.map((group, gi) => (
              <section key={group.title || gi} className={gi > 0 ? 'mt-10' : ''}>
                {group.title && (
                  <h3 className="flex items-center justify-center gap-3 text-fs-2xs font-semibold uppercase tracking-[0.14em] text-hero-ink">
                    <span aria-hidden className="h-px w-10 bg-hero-accent-rule/60 sm:w-16" />
                    <span className={INDEX}>{idx(gi)}</span>
                    {group.mark && <span aria-hidden className="text-fs-sm leading-none">{group.mark}</span>}
                    {group.title}
                    <span aria-hidden className="h-px w-10 bg-hero-accent-rule/60 sm:w-16" />
                  </h3>
                )}

                <div className="grid grid-cols-1 gap-x-10 gap-y-7 pt-7 sm:grid-cols-2">
                  {group.entries.map((entry, ei) => (
                    <article key={entry.title || ei} className="min-w-0">
                      {entry.title && (
                        <h4 className={cn('text-balance', ITEM)}>
                          {entry.mark && <span aria-hidden className="mr-1.5 text-fs-sm leading-none">{entry.mark}</span>}
                          {entry.title}
                        </h4>
                      )}
                      <span aria-hidden className="mt-2 block h-px w-6 bg-hero-accent-rule/70" />
                      {entry.body.map(p => (
                        <p key={p.slice(0, 40)} className={cn(entry.title ? 'mt-2.5' : '', 'text-pretty', BODY)}>{p}</p>
                      ))}
                    </article>
                  ))}
                </div>
              </section>
            ))
          )}

          {/* ── The organiser's own closing statement ────────────────────────── */}
        </div>

        {/* ── The narrow rail: the organiser's own closing statement ──────── */}
        <div className="mx-auto mt-10 min-w-0 max-w-[62ch]">
          {story.closing && (
            <blockquote className="border-t border-border/60 pt-6">
              {story.closing.title && (
                <p className={cn(FIELD, 'mb-3')}>
                  {story.closing.mark && <span aria-hidden className="mr-1.5">{story.closing.mark}</span>}
                  {story.closing.title}
                </p>
              )}
              {story.closing.body.map(p => (
                <p key={p.slice(0, 40)} className="text-pretty text-fs-md leading-relaxed text-hero-ink">
                  {p}
                </p>
              ))}
            </blockquote>
          )}

          {languageNote && <p className={cn(FIELD, 'mt-6 border-t border-border/60 pt-4')}>{languageNote}</p>}
        </div>
      </div>
    </SportsSection>
  )
}
