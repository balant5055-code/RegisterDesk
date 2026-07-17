// ─── Platform Admin shared UI primitives ────────────────────────────────────────
// One design language for every admin content page: toolbar, tables, filters,
// search, status pills, pagination, and error banners. Import from here — never
// re-hand-roll these in a page.

export { AdminToolbar }                          from './AdminToolbar'
export type { AdminToolbarProps }                from './AdminToolbar'

export { StatusPill }                            from './StatusPill'
export type { StatusPillProps, PillTone }        from './StatusPill'

export { TableFrame, THead, Th, TBody, Tr, Td, TableStateRow } from './DataTable'
export type { TableFrameProps, ThProps, TrProps, TdProps }     from './DataTable'

export { SearchInput }                           from './SearchInput'
export type { SearchInputProps }                 from './SearchInput'

export { FilterTabs }                            from './FilterTabs'
export type { FilterTabsProps, FilterTabOption } from './FilterTabs'

export { LoadMoreButton }                        from './LoadMoreButton'
export type { LoadMoreButtonProps }              from './LoadMoreButton'

export { ErrorBanner }                           from './ErrorBanner'
export type { ErrorBannerProps }                 from './ErrorBanner'
