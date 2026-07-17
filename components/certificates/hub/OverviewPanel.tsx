'use client'

import { useEffect, useState } from 'react'
import { Upload, PenSquare, Award } from 'lucide-react'
import { Spinner, ErrorBox, StatCard, btnGhost } from './ui'
import type { CertApi, HubTab } from './api'

export default function OverviewPanel({ api, onNav }: { api: CertApi; onNav: (t: HubTab) => void }) {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [stats, setStats] = useState({ total: 0, generated: 0, emailed: 0, revoked: 0, downloads: 0 })

  useEffect(() => {
    let on = true
    api.getRecords()
      .then(({ certificates }) => {
        if (!on) return
        const revoked = certificates.filter(c => c.status === 'revoked').length
        setStats({
          total:     certificates.length,
          generated: certificates.length - revoked,
          emailed:   certificates.filter(c => c.emailStatus === 'sent').length,
          revoked,
          downloads: certificates.reduce((s, c) => s + (c.downloadCount ?? 0), 0),
        })
      })
      .catch(e => on && setErr(e.message))
      .finally(() => on && setLoading(false))
    return () => { on = false }
  }, [api])

  if (loading) return <Spinner />
  if (err) return <ErrorBox message={err} />

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard label="Total Certificates" value={stats.total} />
        <StatCard label="Generated" value={stats.generated} />
        <StatCard label="Emailed" value={stats.emailed} />
        <StatCard label="Revoked" value={stats.revoked} />
        <StatCard label="Downloads" value={stats.downloads} />
      </div>

      <div>
        <h3 className="mb-3 text-[14px] font-semibold text-foreground">Quick actions</h3>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btnGhost} onClick={() => onNav('templates')}><Upload className="size-3.5" /> Upload Template</button>
          <button type="button" className={btnGhost} onClick={() => onNav('templates')}><PenSquare className="size-3.5" /> Open Builder</button>
          <button type="button" className={btnGhost} onClick={() => onNav('issue')}><Award className="size-3.5" /> Generate Certificates</button>
        </div>
      </div>
    </div>
  )
}
