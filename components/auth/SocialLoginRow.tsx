import type { ReactNode } from 'react'

// ─── SocialLoginRow ───────────────────────────────────────────────────────────
// Presentation-only social sign-in row: a divider + three equal outline buttons.
//
// RegisterDesk has NO OAuth wired (no GoogleAuthProvider / signInWithPopup
// anywhere), and this refinement pass must not touch auth logic. So these are
// DISABLED "coming soon" placeholders — visible for layout parity but non-
// interactive, so nothing pretends to work. When OAuth lands, remove `disabled`
// and wire each provider's onClick; the markup stays.

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

const PROVIDERS: { name: string; icon: ReactNode }[] = [
  { name: 'Google',    icon: GoogleIcon    },
  { name: 'Microsoft', icon: MicrosoftIcon },
  { name: 'Facebook',  icon: FacebookIcon  },
]

// No outer margin — the parent form's vertical rhythm owns the gap above/below.
export function SocialLoginRow() {
  return (
    <div className="space-y-2.5">
      {/* Divider — OR */}
      <div className="flex items-center gap-3" aria-hidden="true">
        <span className="h-px flex-1 bg-border" />
        <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">or</span>
        <span className="h-px flex-1 bg-border" />
      </div>

      {/* Three equal outline buttons — icons left, disabled placeholders */}
      <div className="grid grid-cols-3 gap-3">
        {PROVIDERS.map(({ name, icon }) => (
          <button
            key={name}
            type="button"
            disabled
            title={`${name} sign-in — coming soon`}
            aria-label={`${name} sign-in — coming soon`}
            className="inline-flex h-11 cursor-not-allowed items-center justify-center gap-2 rounded-lg border border-border bg-background text-sm font-medium text-muted-foreground opacity-60"
          >
            {icon}
            <span className="hidden sm:inline">{name}</span>
          </button>
        ))}
      </div>

      <p className="text-center text-[12px] text-muted-foreground/80">Social sign-in coming soon</p>
    </div>
  )
}
