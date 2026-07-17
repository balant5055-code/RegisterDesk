// ─── Layout ───────────────────────────────────────────────────────────────────
export { Container }                            from './Container'

// ─── Navigation ───────────────────────────────────────────────────────────────
export { Breadcrumbs }                          from './Breadcrumbs'
export type { BreadcrumbItem, BreadcrumbsProps } from './Breadcrumbs'

// ─── Typography ───────────────────────────────────────────────────────────────
export { SectionHeading }                       from './section-heading'
export type { SectionHeadingProps }             from './section-heading'
export { SectionHeader }                        from './SectionHeader'
export type { SectionHeaderProps }              from './SectionHeader'
export { PageHeader }                           from './PageHeader'
export type { PageHeaderProps }                 from './PageHeader'

// ─── Buttons ──────────────────────────────────────────────────────────────────
export { Button, buttonVariants }               from './button'
export type { ButtonProps, ButtonVariant, ButtonSize } from './button'

// ─── Cards ────────────────────────────────────────────────────────────────────
export { Card }                                 from './card'
export type { CardProps, CardVariant }          from './card'

// ─── Feedback ────────────────────────────────────────────────────────────────
export { EmptyState, ErrorState }               from './EmptyState'
export type { EmptyStateProps, ErrorStateProps } from './EmptyState'
// EA-4 S3 — the feedback framework primitives are now barrel-exported.
export { ToastProvider, ToastContext, useToast } from './Toast'
export type { ToastType, ToastItem, ToastAction, ToastOptions } from './Toast'
export { ConfirmProvider, useConfirm }          from './ConfirmDialog'
export type { ConfirmOptions, PromptOptions }   from './ConfirmDialog'
export { Spinner }                              from './Spinner'
export type { SpinnerProps }                    from './Spinner'
export { Skeleton }                             from './Skeleton'
export type { SkeletonProps }                   from './Skeleton'
export { ProgressBar }                          from './ProgressBar'
export type { ProgressBarProps, ProgressTone }  from './ProgressBar'
export { Banner }                               from './Banner'
export type { BannerProps, BannerTone }         from './Banner'
export { StatusChip }                           from './StatusChip'
export type { StatusChipProps, StatusTone }     from './StatusChip'
export { Dialog }                               from './Dialog'
export type { DialogProps }                     from './Dialog'

// ─── Misc ────────────────────────────────────────────────────────────────────
export { Badge }                                from './badge'
export type { BadgeProps, BadgeVariant }        from './badge'
