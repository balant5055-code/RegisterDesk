# RD-PHOTO-04 — Branding workflow

Makes Import Media the workflow gate for upload-time branding. The decision is asked once
per event, before the first photo, and every surface renders from one resolved state.

---

## 1. Architecture summary

### The problem

RD-PHOTO-03 changed *when* branding happens but not *where it sits in the workflow*. Branding
became a **precondition of import** while the information architecture still modelled it as an
independent setting reached from a sidebar link. An organizer could create an event, import
4,000 photos and only then discover branding was permanently unavailable — the import page
said nothing at all when no artwork existed.

### Intent is separate from artwork

```
mediaSettings/{organizerUid}
  ├─ branding[eventId]        the artwork   (RD-PHOTO-01)
  └─ brandingIntent[eventId]  the DECISION  (RD-PHOTO-04)   'branded' | 'unbranded'
```

A sibling map on the document that already exists. Same targeted field-path discipline as
`branding` and `eventLimitOverrides`, so a stale tab cannot wipe another event's decision. No
new collection, no new rule, no new index.

They must be separate because **"I want branding" has to be expressible before any artwork
exists.** That is STATE 3, which was structurally unreachable before this sprint: `enabled`
lived *on* the overlay document, so no artwork meant no flag.

### One resolver, five states

`resolveBrandingWorkflow` (pure, unit-tested) is the only place a state is decided. The
import gate, the branding page, the hub card and the gallery badge all render from it, so
they cannot disagree about an event.

| State | Condition | Import | Branding applies |
|---|---|---|---|
| **0 · Undecided** | no intent, no photos | **blocked** | no |
| **1 · Enabled** | `branded` + artwork on | allowed | yes |
| **2 · Disabled** | `unbranded` | allowed | no |
| **3 · Required** | `branded`, artwork missing or off | **blocked** | no |
| **4 · Locked** | photos exist | allowed | whatever the artwork says |

Branch order is the specification. **Locked wins over everything**, so a legacy event with
photos and no recorded intent reports what it actually got rather than what someone later
chose.

### The upload pipeline is untouched

`brandingApplies` is derived from `hasOverlay && overlayEnabled` — the exact condition
`useUploadQueue` already used. Recording a decision keeps the overlay's `enabled` flag in
step (`setBrandingIntent` syncs it), rather than adding a second condition the pipeline must
consult. **`browserImage.ts`, `useUploadQueue.ts` and StorageService are unchanged.**

### One copy module

`brandingCopy.ts` holds every sentence. The audit found the same explanation written five
different ways; when branding was a reversible convenience that was untidy, but on an
irreversible decision an organizer who reads "photos are never modified" on one page and
"this cannot be undone" on another picks the reassuring one.

---

## 2. Workflow

```
Import Media
  1 · Event        2 · Gallery      3 · Branding  ← the gate
  4 · Photos       5 · Compression  6 · Review    7 · Upload
```

Branding sits **before** photo selection, so it is encountered before any effort is invested.
Start is disabled while `canImport` is false — undecided and required only.

**No separate checklist.** Sections 1–7 already are one; a second would be the duplicated
information this sprint removes. State lives in the section instead.

---

## 3. Files modified (9)

| File | Change |
|---|---|
| `photo-branding/services/brandingService.ts` | `+getBrandingIntent`, `+setBrandingIntent` (syncs `enabled`), `+getBrandingWorkflow` |
| `api/organizer/media-studio/branding/route.ts` | `+POST {action:'decide'}`; `workflow` on every response; uploading artwork records `branded` |
| `media-studio/components/ImportClient.tsx` | `+3 · Branding` section, sections renumbered, Start gated, **both Review banners removed** |
| `photo-branding/components/BrandingClient.tsx` | Copy consolidated to `brandingCopy`; status line driven by the resolved state |
| `media-studio/components/MediaStudioHub.tsx` | `+Photo Branding` and `+Maintenance` cards; branding card shows Ready / Not Configured / Disabled / Locked |
| `media-studio/components/GalleryBrowserClient.tsx` | One badge — `Branded` / `No Branding`, no explanation |
| `app/(dashboard)/…/branding/page.tsx` | **Rewritten for upload-time branding** — hero, `STEPS`, all six FAQ answers, banners, numbering |

## 4. Files created (4)

`photo-branding/utils/brandingIntent.ts` (the pure state machine) ·
`photo-branding/utils/brandingCopy.ts` (all wording) ·
`photo-branding/components/BrandingGate.tsx` (the import step) ·
`photo-branding/tests/brandingIntent.test.ts` (19 cases)

## 5. Files removed

**None.** This is a workflow and copy sprint. RD-PHOTO-03 had already deleted the dead
runtime-branding code (`composite.ts`, `brandedDownload.ts`, the `transform` hook, the
organizer's second download button, `PublicBranding`), and the audit re-verified that
`SafeAreaDiagram` and `template.ts` are both live.

---

## 6. Dead text removed

Every download-time claim on the branding page. Each was not merely stale but the **opposite**
of the truth, on the one decision that cannot be undone:

| Was | Now |
|---|---|
| "The overlay is placed onto a copy at the moment someone downloads" | Merged during import |
| "The stored photo is byte-for-byte what you uploaded. Always." | The branded photo IS the stored photo |
| FAQ "Will my original photos change?" → **"No."** | "Yes — deliberately." |
| FAQ "Can I replace the branding later?" → **"Yes, at any time."** | "Only until the event has its first photo." |
| FAQ "Can I remove branding entirely?" → "Yes… photos untouched" | Replaced with what happens if you change your mind |
| FAQ "Does this affect photos already imported?" → "Yes, immediately" | "No. Future imports only." |
| Hero: "without touching a single original" | "applied once during import" |
| "Branding, not protection" — framed around reaching the unbranded original | Reframed: branding is not access control |

Also removed: the two duplicate branding banners in Import's Review step, and three separate
paraphrases inside `BrandingClient`.

Fixed in passing: section numbering (`── 9 ·` comment over `title="8 ·"`, and the same off-by-one
on FAQ and Best practices).

---

## 7. Verification

| Case | Expected |
|---|---|
| New event, never asked | STATE 0, two buttons, **Start disabled** |
| Choose *Import Without Branding* | STATE 2, Start enabled, photos unbranded |
| Choose *Use Photo Branding*, no artwork | STATE 3, **Start disabled**, "Upload Branding" link |
| Upload artwork | STATE 1, overlay shown on a checkerboard, Start enabled |
| Artwork switched off after choosing branded | STATE 3 — blocks rather than silently importing unbranded |
| Import one photo | STATE 4 everywhere; branding page controls disabled; API 409 |
| Legacy event (photos, no intent) | STATE 4, reports `No Branding` — never claims branding it never had |
| Hub card | Ready / Not Configured / Disabled / Locked, from the same resolver |
| Gallery browser | Exactly one badge, two words |
| Branding read fails | Treated as **undecided**, import paused — never as "no branding" |

| Gate | Result |
|---|---|
| TypeScript | **0** |
| ESLint (scoped: `features/photo-branding`, `features/media-studio`, both media-studio route trees) | **0** |
| ESLint (repo) | **205** — unchanged baseline, all pre-existing and outside this sprint |
| Tests | **98 files / 1278 passing** (+19) |
| Next build | **exit 0** |

Property tests cover all 36 combinations of intent × artwork × enabled × photo count and
assert: exactly one state each, `locked` agrees with the count, import blocks **only** for
undecided and required, and `brandingApplies` is never true without usable artwork.

---

## 8. Risks

| Risk | Sev | Note |
|---|---|---|
| **No visual QA** | **High** | No state has been rendered in a browser. Walk all five before a real event. |
| Legacy events with artwork but no intent | Med | Resolve to **undecided** and are asked once. If they already have photos they are locked and report honestly. No data migration is performed — deliberately, since branding never went live. |
| Three branding reads per import page load | Low | Import, hub and gallery each read one `mediaSettings` document plus one aggregate count. All fail soft. |
| `countEventAssets` fails open (0) | Low | Pre-existing and deliberate — a failed count must not block uploads. Briefly leaves branding editable. |
| Decision is not itself reversible via UI once photos exist | Low | By design; the lock is the point. |

## 9. Still outstanding (unchanged)

`npm run deploy:firebase` has never been run — Firestore rules and ~24 accumulated indexes
are undeployed. `/api/cron/media-jobs` and `/api/cron/ai-jobs` are unscheduled.

## 10. Ready for review
