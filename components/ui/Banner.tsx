import { CheckCircle2, AlertCircle, AlertTriangle, Info, X } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

export type BannerTone = 'info' | 'success' | 'warning' | 'error'

export interface BannerProps {
  tone?:      BannerTone
  title?:     string
  children?:  React.ReactNode
  action?:    React.ReactNode
  onDismiss?: () => void
  className?: string
}

const TONE: Record<BannerTone, { icon: typeof Info; ring: string; iconCls: string }> = {
  info:    { icon: Info,          ring: 'border-info/30 bg-info/5',                iconCls: 'text-info' },
  success: { icon: CheckCircle2,  ring: 'border-success/30 bg-success/5',          iconCls: 'text-success' },
  warning: { icon: AlertTriangle, ring: 'border-warning/30 bg-warning/5',          iconCls: 'text-warning' },
  error:   { icon: AlertCircle,   ring: 'border-destructive/30 bg-destructive/5',  iconCls: 'text-destructive' },
}

/** Inline, dismissible alert/callout (EA-4 S3). Error/warning use role="alert";
 *  info/success use role="status" — the same live-region convention as toasts. */
export function Banner({ tone = 'info', title, children, action, onDismiss, className }: BannerProps) {
  const t = TONE[tone]
  const Icon = t.icon
  return (
    <div
      role={tone === 'error' || tone === 'warning' ? 'alert' : 'status'}
      className={cn('flex items-start gap-3 rounded-xl border px-4 py-3 text-foreground', t.ring, className)}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', t.iconCls)} aria-hidden />
      <div className="min-w-0 flex-1 text-[13px]">
        {title && <p className="font-semibold leading-snug">{title}</p>}
        {children && <div className={cn('leading-snug', title && 'mt-0.5 opacity-90')}>{children}</div>}
      </div>
      {action}
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="rounded-lg p-0.5 text-muted-foreground opacity-70 transition-opacity hover:opacity-100">
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}
