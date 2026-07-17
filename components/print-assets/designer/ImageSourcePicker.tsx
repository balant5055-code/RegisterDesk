'use client'

// PA-9 Sprint 2 — Image Source Picker. Sets the image element's source (stored in
// the EXISTING properties.text field — no schema change) to an engine token, so
// organizers never type {{logo}}. "Custom Variable" writes {{custom.<key>}}.

import { useState } from 'react'
import { IMAGE_SOURCES, imageSourceKey } from '@/lib/printAssets/designer/previewData'

const numCls = 'w-full rounded border border-border bg-background px-2 py-1 text-[12px]'

function customKeyOf(text: string): string {
  const m = (text ?? '').trim().match(/^\{\{\s*custom\.(.+?)\s*\}\}$/)
  return m ? m[1] : ''
}

export function ImageSourcePicker({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  const currentKey = imageSourceKey(value)
  const [customKey, setCustomKey] = useState(customKeyOf(value))

  function selectSource(key: string) {
    const opt = IMAGE_SOURCES.find(s => s.key === key)
    if (!opt) return
    if (opt.custom) onChange(customKey ? `{{custom.${customKey}}}` : '')
    else onChange(opt.token)
  }

  return (
    <div className="space-y-2">
      <label className="flex items-center justify-between gap-2">
        <span className="text-[12px] text-muted-foreground">Source</span>
        <select className={numCls + ' max-w-[9.5rem]'} value={currentKey || ''} onChange={e => selectSource(e.target.value)}>
          <option value="">None</option>
          {IMAGE_SOURCES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </label>
      {currentKey === 'custom' && (
        <label className="block">
          <span className="text-[12px] text-muted-foreground">Custom variable key</span>
          <div className="mt-1 flex items-center gap-1">
            <span className="text-[12px] text-muted-foreground">{'{{custom.'}</span>
            <input className={numCls} value={customKey} placeholder="photo"
              onChange={e => { const k = e.target.value.replace(/[^a-zA-Z0-9_.-]/g, ''); setCustomKey(k); onChange(k ? `{{custom.${k}}}` : '') }} />
            <span className="text-[12px] text-muted-foreground">{'}}'}</span>
          </div>
        </label>
      )}
      <p className="text-[11px] text-muted-foreground">Images resolve from your branding, event assets and registration fields at render time.</p>
    </div>
  )
}
