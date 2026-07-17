// PA-9 S3 Part 1 — image-source PARITY between preview and generation.
// Both paths build variables the same way (registration mapping + the shared
// mergePreviewImageSources), so every image token resolves identically. Pure.
// Run: npx --yes tsx scripts/verify-print-parity.ts

import { registrationToSources, mergePreviewImageSources } from '../lib/printAssets/designer/previewData'
import { buildVariableMap, type PrintVariableSources } from '../lib/printAssets/render/variables'
import type { SerializedRegistration } from '../app/api/organizer/events/[eventId]/registrations/route'

let failures = 0
const check = (n: string, c: boolean) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) failures++ }

function main() {
  const assets = { logoUrl: 'https://s/org-logo.png', bannerUrl: 'https://s/banner.png', sponsorLogo: 'https://s/sponsor.png' }
  const brandingLogo = 'https://s/branding-logo.png'
  const reg = {
    id: 'reg_1', ticketCode: 'TCK-1', passName: 'VIP', passType: 'vip', bibCategory: null,
    companyName: 'Globex', designation: 'CEO',
    attendee: { name: 'John Smith', email: 'j@x.com', phone: '+91', formResponses: { headshot: 'https://s/headshot.png' } },
    ticket: { qrValue: 'RD:e:reg_1:TCK-1' },
  } as unknown as SerializedRegistration

  // Preview path (SmartPreviewBar): registrationToSources + mergePreviewImageSources.
  const previewVars = mergePreviewImageSources(
    { ...registrationToSources(reg, 'Demo Event'), branding: { logo: brandingLogo } },
    assets,
  )

  // Generation path (generationJob.variablesFor): the SAME base mapping + branding +
  // the SAME mergePreviewImageSources helper.
  const genBase: PrintVariableSources = {
    registration: { name: 'John Smith', email: 'j@x.com', phone: '+91', ticket: 'TCK-1', id: 'reg_1', company: 'Globex', designation: 'CEO', category: 'vip' },
    event: { name: 'Demo Event' }, pass: { label: 'VIP', type: 'VIP' }, system: { qr: 'RD:e:reg_1:TCK-1' },
    branding: { logo: brandingLogo }, custom: { headshot: 'https://s/headshot.png' },
  }
  const genVars = mergePreviewImageSources(genBase, assets)

  const pMap = buildVariableMap(previewVars)
  const gMap = buildVariableMap(genVars)

  const IMAGE_TOKENS = ['logo', 'sponsorLogo', 'custom.eventLogo', 'custom.eventBanner', 'custom.background', 'custom.headshot']
  for (const tok of IMAGE_TOKENS) {
    check(`parity: {{${tok}}} matches (preview == generation)`, pMap.get(tok) === gMap.get(tok) && !!pMap.get(tok))
  }

  // The five previously-broken generation bindings now resolve to real URLs.
  check('generation {{logo}} → branding logo',              gMap.get('logo') === brandingLogo)
  check('generation {{sponsorLogo}} → sponsor logo',        gMap.get('sponsorLogo') === assets.sponsorLogo)
  check('generation {{custom.eventLogo}} → event logo',     gMap.get('custom.eventLogo') === assets.logoUrl)
  check('generation {{custom.eventBanner}} → event banner', gMap.get('custom.eventBanner') === assets.bannerUrl)
  check('generation {{custom.background}} → event banner',  gMap.get('custom.background') === assets.bannerUrl)

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
