'use client'

// PA-9 Sprint 2 — Variable Inspector. Shows each {{token}} in a text element with
// its resolved value (from the current preview data) and a valid/unknown status.
// Uses the EXISTING engine map (buildVariableMap output) — no new resolver.

import { CheckCircle2, AlertTriangle } from 'lucide-react'
import { TEXT_VARIABLES } from '@/lib/printAssets/designer/previewData'

const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g
const KNOWN = new Set(TEXT_VARIABLES.map(v => v.token))

export function VariableInspector({ text, map }: { text: string; map: Map<string, string> }) {
  const tokens: string[] = []
  for (const m of (text ?? '').matchAll(TOKEN_RE)) if (!tokens.includes(m[1])) tokens.push(m[1])
  if (tokens.length === 0) return null

  return (
    <div className="space-y-1">
      {tokens.map(tok => {
        const known = map.has(tok) || KNOWN.has(tok) || tok.startsWith('custom.')
        const value = map.get(tok) ?? ''
        return (
          <div key={tok} className="flex items-center justify-between gap-2 rounded border border-border px-2 py-1 text-[11.5px]">
            <code className="shrink-0 text-muted-foreground">{`{{${tok}}}`}</code>
            <span className="min-w-0 flex-1 truncate text-right text-foreground">{value || (known ? '—' : 'unknown')}</span>
            {known
              ? <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" aria-label="Valid" />
              : <AlertTriangle className="size-3.5 shrink-0 text-amber-500" aria-label="Unknown variable" />}
          </div>
        )
      })}
    </div>
  )
}
