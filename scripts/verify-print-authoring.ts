// PA-9 S2 verification — authoring data reuses the engine; profiles/registration/
// image sources resolve. Pure (no Firebase/fonts). Run: npx tsx scripts/verify-print-authoring.ts

import {
  PREVIEW_PROFILES, TEXT_VARIABLES, IMAGE_SOURCES, imageSourceKey,
  customFieldVariables, registrationToSources, mergePreviewImageSources,
} from '../lib/printAssets/designer/previewData'
import { buildVariableMap, resolvePrintText, PRINT_VARIABLES } from '../lib/printAssets/render/variables'
import type { SerializedRegistration } from '../app/api/organizer/events/[eventId]/registrations/route'

let failures = 0
const check = (n: string, c: boolean) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) failures++ }

function main() {
  // Profiles — each resolves through the ENGINE (buildVariableMap + resolvePrintText).
  check('7 preview profiles', PREVIEW_PROFILES.length === 7)
  for (const p of PREVIEW_PROFILES) {
    const map = buildVariableMap(p.sources)
    const out = resolvePrintText('{{name}} · {{pass}} · {{event}}', map)
    if (!(out.includes(p.sources.registration?.name as string) && out.includes('Tech Summit 2026'))) {
      check(`profile ${p.id} resolves name/pass/event`, false)
    }
  }
  check('all profiles resolve name/pass/event', failures === 0)

  // Text catalog is built from the engine registry (not duplicated).
  check('TEXT_VARIABLES includes every PRINT_VARIABLES token', PRINT_VARIABLES.every(v => TEXT_VARIABLES.some(t => t.token === v.token)))

  // Image sources map to engine-resolvable tokens.
  check('image sources cover the 6 required', IMAGE_SOURCES.length === 6)
  check('Organizer Logo → {{logo}}', IMAGE_SOURCES.find(s => s.key === 'organizerLogo')?.token === '{{logo}}')
  check('reverse-map: {{logo}} → organizerLogo', imageSourceKey('{{logo}}') === 'organizerLogo')
  check('reverse-map: {{custom.photo}} → custom', imageSourceKey('{{custom.photo}}') === 'custom')
  check('reverse-map: empty → none', imageSourceKey('') === '')

  // Custom field variables from event form labels.
  const cv = customFieldVariables({ bloodGroup: 'Blood Group', tshirt: 'T-Shirt Size' })
  check('custom fields → {{custom.<id>}}', cv.length === 2 && cv[0].token === 'custom.bloodGroup' && cv[0].category === 'custom')

  // Registration → sources mirrors generation-time mapping.
  const reg = {
    id: 'reg_9', ticketCode: 'TCK-9', passName: 'VIP', passType: 'vip', bibCategory: null,
    companyName: 'Globex', designation: 'CEO',
    attendee: { name: 'Mary Joseph', email: 'mary@x.com', phone: '+91 1', formResponses: { bloodGroup: 'O+' } },
    ticket: { qrValue: 'RD:e:reg_9:TCK-9' },
  } as unknown as SerializedRegistration
  const rs = registrationToSources(reg, 'Demo Event')
  const rmap = buildVariableMap(rs)
  check('registration name resolves', rmap.get('name') === 'Mary Joseph')
  check('registration ticket resolves', rmap.get('ticket') === 'TCK-9')
  check('registration company resolves', rmap.get('company') === 'Globex')
  check('registration custom field resolves', rmap.get('custom.bloodGroup') === 'O+')
  check('registration qr resolves', rmap.get('qr') === 'RD:e:reg_9:TCK-9')

  // Image-source injection makes event/sponsor logos previewable.
  const merged = mergePreviewImageSources(rs, { logoUrl: 'https://s/logo.png', bannerUrl: 'https://s/banner.png', sponsorLogo: 'https://s/sp.png' })
  const mmap = buildVariableMap(merged)
  check('injected {{sponsorLogo}} resolves', mmap.get('sponsorLogo') === 'https://s/sp.png')
  check('injected {{custom.eventLogo}} resolves', mmap.get('custom.eventLogo') === 'https://s/logo.png')
  check('injected {{custom.eventBanner}} resolves', mmap.get('custom.eventBanner') === 'https://s/banner.png')

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
