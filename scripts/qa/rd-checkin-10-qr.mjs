// RD-CHECKIN-10 — build a Y4M video file containing a QR code.
//
// Chromium can be handed a raw Y4M file as its camera
// (--use-file-for-fake-video-capture), which makes getUserMedia, the video element
// and the @zxing decoder all run for real. That is materially more than mocking the
// decoder — but it is still NOT a physical device, and this phase's Phase 2 result
// is reported accordingly.
//
// The QR is drawn from qrcode's module matrix directly, so no PNG decoder is needed:
// Y = 0 for a dark module, 255 for light; U and V are flat 128 (greyscale in I420).

import QRCode from 'qrcode'
import fs from 'node:fs'

const W = 640, H = 480          // both even — I420 needs half-resolution chroma

export function writeQrY4m(text, file, { frames = 30, scale = 8 } = {}) {
  const qr   = QRCode.create(text, { errorCorrectionLevel: 'M' })
  const size = qr.modules.size
  const data = qr.modules.data

  const quiet = 4                                   // modules of mandatory quiet zone
  const total = (size + quiet * 2) * scale
  if (total > Math.min(W, H)) throw new Error(`QR ${total}px does not fit in ${W}x${H}`)
  const originX = ((W - total) >> 1)
  const originY = ((H - total) >> 1)

  // Y plane: white page, dark modules painted in the middle.
  const Y = Buffer.alloc(W * H, 255)
  for (let my = 0; my < size; my++) {
    for (let mx = 0; mx < size; mx++) {
      if (!data[my * size + mx]) continue            // 0 = light module
      const px = originX + (mx + quiet) * scale
      const py = originY + (my + quiet) * scale
      for (let dy = 0; dy < scale; dy++) {
        Y.fill(0, (py + dy) * W + px, (py + dy) * W + px + scale)
      }
    }
  }
  const U = Buffer.alloc((W >> 1) * (H >> 1), 128)
  const V = Buffer.alloc((W >> 1) * (H >> 1), 128)

  const out = [Buffer.from(`YUV4MPEG2 W${W} H${H} F15:1 Ip A1:1 C420jpeg\n`)]
  for (let f = 0; f < frames; f++) out.push(Buffer.from('FRAME\n'), Y, U, V)
  fs.writeFileSync(file, Buffer.concat(out))
  return { file, text, size, total }
}
