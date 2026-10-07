// RD-PREPROD · the web app manifest and /favicon.ico.
//
// The manifest had lost start_url, scope and description, and its icons were maskable-only (a
// maskable icon is cropped to a circle/squircle, so it is the wrong artwork wherever an `any`
// icon is wanted). /favicon.ico 404'd because app/favicon.ico — the file Next emits it from —
// was deleted with the old homepage; it now carries the CURRENT artwork from public/favicon.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'

const manifest = JSON.parse(readFileSync('public/favicon/site.webmanifest', 'utf8')) as {
  name: string; description?: string; start_url?: string; scope?: string; display?: string
  theme_color?: string; background_color?: string
  icons: { src: string; sizes: string; type: string; purpose?: string }[]
}

describe('site.webmanifest', () => {
  it('declares start_url, scope and a description', () => {
    expect(manifest.start_url).toBe('/')
    expect(manifest.scope).toBe('/')
    expect((manifest.description ?? '').length).toBeGreaterThan(10)
  })

  it('has an `any` AND a `maskable` icon at 192 and 512, each pointing at a real file', () => {
    for (const size of ['192x192', '512x512']) {
      for (const purpose of ['any', 'maskable']) {
        const icon = manifest.icons.find(i => i.sizes === size && (i.purpose ?? 'any').split(' ').includes(purpose))
        expect(icon, `${size} ${purpose}`).toBeTruthy()
        expect(existsSync(`public${icon!.src}`), icon!.src).toBe(true)
      }
    }
  })

  it('keeps the current theme and display', () => {
    expect(manifest.theme_color).toBe('#ffffff')
    expect(manifest.background_color).toBe('#ffffff')
    expect(manifest.display).toBe('standalone')
  })
})

describe('/favicon.ico', () => {
  it('app/favicon.ico exists and is the CURRENT artwork (public/favicon/favicon.ico)', () => {
    const md5 = (p: string) => createHash('md5').update(readFileSync(p)).digest('hex')
    expect(existsSync('app/favicon.ico')).toBe(true)
    expect(md5('app/favicon.ico')).toBe(md5('public/favicon/favicon.ico'))
  })
})
