'use client'

// Event-day QR for the public Certificate Center.
//
// The organizer prints this and puts it on a table at the venue. Scanning it opens
// /events/{slug}/certificates, where the attendee identifies themselves and picks their
// own certificate.
//
// The encoded value is ONLY the public Certificate Center URL — no attendee name, email,
// registration id, certificate id or token. One poster serves the whole event, and a
// photograph of it reveals nothing about any participant.
//
// QR generation reuses the existing `qrModules` seam (lib/qr/draw.ts), the same matrix
// source the ticket PDFs use, painted here onto a canvas instead of a PDF page. No second
// QR library, and no second definition of what a QR for this platform looks like.

import { useEffect, useRef, useState } from 'react'
import { Copy, Check, Download, Printer } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { qrModules } from '@/lib/qr/draw'
import { btnGhost } from './ui'

/** Painted well above display size so the same canvas is print-sharp later. */
const MODULE_PX = 12
const QUIET     = 4      // spec-required quiet zone, in modules

export function CertificateQrDialog({
  open, onClose, url,
}: {
  open:    boolean
  onClose: () => void
  url:     string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [copied, setCopied] = useState(false)
  // The SAME pixels the dialog shows. Exporting from the painted canvas rather than
  // re-generating guarantees the printed/downloaded code is byte-identical to the one the
  // organizer verified on screen — no second render that could drift.
  const [pngUrl, setPngUrl] = useState<string>('')

  useEffect(() => {
    if (!open || !url) return
    const canvas = canvasRef.current
    if (!canvas) return

    const { dim, isDark } = qrModules(url, 'M')
    const total = (dim + QUIET * 2) * MODULE_PX
    canvas.width  = total
    canvas.height = total

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    // White quiet zone first — a transparent margin makes the code unreadable against a
    // dark background once it is printed or pasted into a slide.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, total, total)
    ctx.fillStyle = '#000000'
    for (let r = 0; r < dim; r++) {
      for (let c = 0; c < dim; c++) {
        if (isDark(r, c)) {
          ctx.fillRect((c + QUIET) * MODULE_PX, (r + QUIET) * MODULE_PX, MODULE_PX, MODULE_PX)
        }
      }
    }
    setPngUrl(canvas.toDataURL('image/png'))
  }, [open, url])

  function handleClose() { setCopied(false); onClose() }

  function downloadPng() {
    if (!pngUrl) return
    const a = document.createElement('a')
    a.href = pngUrl
    a.download = 'certificate-download-qr.png'
    a.click()
  }

  // Print approach: the project has no global print stylesheet, only Tailwind `print:`
  // utilities, so the poster ships its own scoped rules. `visibility` (not `display`) is
  // used to blank the app, because it preserves layout and avoids reflow artefacts, and
  // the fixed poster then covers exactly one A4 page.
  function printPoster() { window.print() }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard blocked — the URL below is still selectable */ }
  }

  return (
    <Dialog open={open} onClose={handleClose} title="Certificate Download QR" size="md">
      <div className="space-y-4">
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          Participants can scan this QR code on event day to find and download their
          certificate.
        </p>

        <div className="flex justify-center">
          {/* Rendered large in CSS but painted at 12px/module, so it stays crisp when the
              dialog is screenshotted or the canvas is exported later. */}
          <canvas
            ref={canvasRef}
            role="img"
            aria-label="QR code linking to the public Certificate Center"
            className="h-auto w-full max-w-[240px] rounded-xl border border-border bg-white"
          />
        </div>

        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Certificate Center link
          </p>
          {/* break-all so a long slug wraps instead of widening the dialog at 390px. */}
          <p className="break-all rounded-lg border border-border bg-muted/25 px-3 py-2 font-mono text-[12px] text-foreground">
            {url}
          </p>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <button type="button" onClick={downloadPng} disabled={!pngUrl} className={`${btnGhost} min-h-11 justify-center disabled:opacity-40`}>
          <Download className="size-3.5" aria-hidden /> Download QR
        </button>
        <button type="button" onClick={printPoster} disabled={!pngUrl} className={`${btnGhost} min-h-11 justify-center disabled:opacity-40`}>
          <Printer className="size-3.5" aria-hidden /> Print Poster
        </button>
        <button type="button" onClick={() => void copyLink()} className={`${btnGhost} min-h-11 justify-center`}>
          {copied
            ? <><Check className="size-3.5 text-emerald-600" aria-hidden /> Copied</>
            : <><Copy className="size-3.5" aria-hidden /> Copy Link</>}
        </button>
        <button type="button" onClick={handleClose} className={`${btnGhost} min-h-11 justify-center`}>
          Close
        </button>
      </div>

      {/* ══ A4 print poster ══════════════════════════════════════════════════
          Hidden on screen; on print it becomes the ONLY visible element and fills a
          single A4 portrait page. It reuses `pngUrl` — the exact QR shown above. */}
      <style>{`
        @media print {
          @page { size: A4 portrait; margin: 0; }
          body * { visibility: hidden !important; }
          #cert-qr-poster, #cert-qr-poster * { visibility: visible !important; }
          #cert-qr-poster { display: flex !important; position: fixed; inset: 0; }
        }
      `}</style>
      <div
        id="cert-qr-poster"
        aria-hidden
        className="hidden flex-col items-center justify-center bg-white px-16 text-center"
      >
        <p className="text-[22px] font-extrabold uppercase tracking-[0.28em] text-black">RegisterDesk</p>
        <h2 className="mt-10 text-[46px] font-extrabold uppercase leading-tight tracking-tight text-black">
          Download Your Certificate
        </h2>
        {pngUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={pngUrl} alt="" className="mt-10 size-[380px]" />
        )}
        <p className="mt-10 text-[26px] font-bold text-black">Scan the QR code</p>
        <p className="mt-3 text-[20px] text-black">Enter your Email or Registration ID</p>
        <p className="mt-1.5 text-[20px] text-black">Find your name and download your certificate.</p>
      </div>
    </Dialog>
  )
}
