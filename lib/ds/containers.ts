// ─── RegisterDesk Container System ───────────────────────────────────────────
//
// Five canonical layout widths.  Use these instead of arbitrary max-w-[*]
// values throughout the app.
//
// Usage:
//   import { container } from '@/lib/ds/containers'
//
//   // Tailwind class strings — apply directly or merge with cn()
//   <div className={container.page}>...</div>
//   <div className={cn(container.modal, 'my-8')}>...</div>
//
// Widths at a glance:
//   page    1280px  All full-width sections, page-level layouts
//   content  820px  Centered prose / article bodies, FilterBar inner
//   modal    576px  All dialogs and overlay modals
//   auth     420px  Login / register / verify auth forms
//   narrow   320px  Paragraph constraints, small card text
// ─────────────────────────────────────────────────────────────────────────────

export const container = {
  /** 1280px — full-width sections and page layouts (replaces max-w-[1280px]) */
  page:    'mx-auto w-full max-w-7xl    px-4 sm:px-6 lg:px-8',

  /** 820px — centered content areas, article bodies, FilterBar inner */
  content: 'mx-auto w-full max-w-[820px] px-4 sm:px-6',

  /** 576px — all modals and dialogs (replaces max-w-[560px] / max-w-[600px]) */
  modal:   'mx-auto w-full max-w-xl',

  /** 420px — auth page forms (login, register, verify) */
  auth:    'mx-auto w-full max-w-[420px]',

  /** 320px — paragraph text constraints, small card bodies */
  narrow:  'mx-auto w-full max-w-xs',
} as const

export type ContainerSize = keyof typeof container
