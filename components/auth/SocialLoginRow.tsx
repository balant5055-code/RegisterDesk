import type { ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { SocialProviderKey } from '@/lib/firebase/auth/social'
import type { AuthFieldAccent } from './AuthField'

export type SocialLoginRowVariant = 'boxes' | 'group' | 'plain'

// ─── SocialLoginRow ───────────────────────────────────────────────────────────
// Social sign-in row: a divider + three equal outline buttons (Google / Microsoft /
// Facebook). RD-AUTH-02 Phases 7–9 wired these to real OAuth — each button invokes
// `onSelect(key)`; the page owns the popup + linking flow. Presentation-only: no
// Firebase here. When `onSelect` is absent the buttons render disabled (defensive).

const GoogleIcon = (
  <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden="true">
    <path d="M12 11v2.9h6.6c-.3 1.7-2 5-6.6 5-4 0-7.2-3.3-7.2-7.3S8 4.3 12 4.3c2.3 0 3.8.9 4.7 1.7l3.2-3C17.9 1.2 15.2 0 12 0 5.9 0 1 4.9 1 11s4.9 11 11 11c6.4 0 10.6-4.5 10.6-10.8 0-.7-.1-1.3-.2-2H12z" />
  </svg>
)

const MicrosoftIcon = (
  <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden="true">
    <path d="M2 2h9.2v9.2H2V2Zm10.8 0H22v9.2h-9.2V2ZM2 12.8h9.2V22H2v-9.2Zm10.8 0H22V22h-9.2v-9.2Z" />
  </svg>
)

const FacebookIcon = (
  <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden="true">
    <path d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.5c-1.49 0-1.96.93-1.96 1.89v2.25h3.33l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07Z" />
  </svg>
)

const PROVIDERS: { key: SocialProviderKey; name: string; icon: ReactNode }[] = [
  { key: 'google',    name: 'Google',    icon: GoogleIcon    },
  { key: 'microsoft', name: 'Microsoft', icon: MicrosoftIcon },
  { key: 'facebook',  name: 'Facebook',  icon: FacebookIcon  },
]

export interface SocialLoginRowProps {
  /** Invoked with the chosen provider. Absent → buttons render disabled. */
  onSelect?:   (key: SocialProviderKey) => void
  /** The provider whose popup is currently in flight (shows a spinner). */
  loadingKey?: SocialProviderKey | null
  /**
   * Focus/hover accent, matched to the fields above the row. Defaults to the
   * organizer magenta, which is what /admin/login has always rendered; the public
   * /login passes 'action' so the whole column stays on one ramp.
   */
  accent?:     AuthFieldAccent
  /**
   * The word set between the two divider rules. Defaults to 'or' — unchanged for
   * every existing caller. The public sign-in screen says what the row actually
   * does ('or continue with'), which is worth the extra two words on the one
   * surface where a first-time visitor is deciding how to create an account.
   */
  label?:      string
  /**
   * 'boxes' (default) draws three separate outlined buttons — what every existing
   * caller has always rendered. 'group' draws ONE outlined row divided into three
   * cells by hairlines.
   *
   * 'plain' is 'group' with the outer border removed — for use INSIDE a container
   * that already has one, where a bordered row would draw a box inside a box.
   *
   * Three adjacent identical rectangles read as three decisions; one divided row
   * reads as one decision with three answers, which is what this actually is.
   */
  variant?:    SocialLoginRowVariant
}

/** Focus/hover per accent. Same geometry either way — only the colour moves. */
const ACCENT_CLASSES: Record<AuthFieldAccent, string> = {
  primary: 'hover:bg-muted focus-visible:ring-primary',
  action:  'hover:border-border-strong hover:bg-muted focus-visible:ring-action',
}

/** The row that holds the three cells. */
const ROW_CLASSES: Record<SocialLoginRowVariant, string> = {
  boxes: 'grid grid-cols-3 gap-3',
  group: 'grid grid-cols-3 overflow-hidden rounded-control border border-border divide-x divide-border',
  plain: 'grid grid-cols-3 divide-x divide-border',
}

/** And the cell itself. Only 'boxes' carries a border of its own. */
const CELL_CLASSES: Record<SocialLoginRowVariant, string> = {
  boxes: 'h-11 rounded-lg border border-border bg-background text-sm font-medium text-foreground',
  group: 'h-12 border-0 bg-transparent text-fs-sm font-medium text-muted-foreground hover:text-foreground',
  plain: 'h-11 border-0 bg-transparent text-fs-sm font-medium text-muted-foreground hover:text-foreground',
}

// No outer margin — the parent form's vertical rhythm owns the gap above/below.
export function SocialLoginRow({
  onSelect,
  loadingKey = null,
  accent = 'primary',
  label = 'or',
  variant = 'boxes',
}: SocialLoginRowProps) {
  const anyLoading = loadingKey != null

  return (
    <div className="space-y-2.5">
      {/* Divider — OR */}
      <div className="flex items-center gap-3" aria-hidden="true">
        <span className="h-px flex-1 bg-border" />
        <span className="whitespace-nowrap text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</span>
        <span className="h-px flex-1 bg-border" />
      </div>

      {/* Three equal cells — icons left */}
      <div className={ROW_CLASSES[variant]}>
        {PROVIDERS.map(({ key, name, icon }) => {
          const isLoading = loadingKey === key
          const disabled  = !onSelect || anyLoading
          return (
            <button
              key={key}
              type="button"
              disabled={disabled}
              onClick={() => onSelect?.(key)}
              title={`Continue with ${name}`}
              aria-label={`Continue with ${name}`}
              className={cn(
                'inline-flex cursor-pointer items-center justify-center gap-2 transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:-outline-offset-1',
                'disabled:cursor-not-allowed disabled:opacity-60',
                CELL_CLASSES[variant],
                // The group variant already has one border; giving each cell a hover
                // border as well would draw the three boxes it exists to remove.
                variant === 'boxes'
                  ? ACCENT_CLASSES[accent]
                  : 'hover:bg-muted focus-visible:ring-inset focus-visible:ring-action',
              )}
            >
              {isLoading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
              <span className="hidden sm:inline">{name}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
