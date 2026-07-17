import { Loader2 } from 'lucide-react'

// ─── LoadMoreButton ─────────────────────────────────────────────────────────────
// Centered cursor-pagination trigger shared by every admin list. Cursor-based only
// (the admin APIs return `nextCursor`) — there is no offset pagination anywhere.

export interface LoadMoreButtonProps {
  onClick:  () => void
  loading?: boolean
  label?:   string
}

export function LoadMoreButton({ onClick, loading = false, label = 'Load more' }: LoadMoreButtonProps) {
  return (
    <div className="flex justify-center">
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-[13.5px] font-medium text-foreground hover:bg-muted disabled:opacity-60"
      >
        {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
        {label}
      </button>
    </div>
  )
}
