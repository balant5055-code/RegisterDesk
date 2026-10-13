# Print & Assets: release readiness (Phases 0–4)

**Status:** this has not been deployed. **No Vercel validation has been performed.** Every
number below was measured locally, or proven on the Firebase emulators.

**Audience:** whoever approves and validates the release.

## What ships

| Phase | Behaviour |
|---|---|
| 0 | Generated PDFs, ZIPs and token URLs are never stored. Job history holds metadata only, with no attendee copy. Every print route requires the `certificates` permission plus workspace ownership. Login tokens are accepted only in the request header, never in the URL. |
| 1 | Every template change creates an immutable version (`printTemplateVersions`). Each job is pinned to a version. Archived templates can't start a new job. Duplicating a template keeps its design. |
| 2 | Custom card sizes in mm or inches. A4 and A3 sheets, with margins, gaps and crop marks. Cards are rendered directly onto the sheets, clipped to their own edges, and a logo is embedded once per document. |
| 3 | One combined PDF for up to 5,000 cards. The server plans the run, renders it in strict, sheet-aligned batches, and the browser merges them. The download happens only after the server confirms completion. Text-overflow problems are reported as warnings. |
| 4 | Abandoned runs expire: lazily after 24 h, plus a daily sweep. Identical images are de-duplicated in the merged PDF. History shows a clear status label and message. Planning refuses a job that is still generating, and reports every card that won't be printed. |

## Data and infrastructure changes

- **New Firestore collections** (no client access; the rules deny by default): `printTemplateVersions`, `printRuns`.
- **Indexes:** none needed. Every new query is a single-field query, sorted in memory.
- **Firestore and Storage rules:** unchanged.
- **New cron:** `print-runs-reconcile`, added to `cron-maintenance.yml` (daily, 02:00 UTC). It changes only the status fields of stale planned runs.
- **Event deletion:** now also removes `printTemplateVersions` and `printRuns`.
- **Production legacy inventory** (read-only, 2026-10-09): 0 stored print objects and 0 legacy records. No clean-up is needed.

## Measured locally (not on Vercel)

The test card was CR80 with an 89 KB logo, a QR code and long names, laid out on A4 at 9 per sheet with crop marks.

| Measurement | Local result | Limit enforced in code |
|---|---|---|
| One batch (198 cards) | 1.2–1.9 s, ≤ 0.97 MB | 500 cards, 4 MiB, 45 s render budget, 60 s `maxDuration` |
| Single sheet download (500 cards) | 3.7 s, 2.9 MB, about +0.44 GB memory | same |
| Combined, 5,000 cards | 26 batches, merge 9.8 s, final 22.5 MB (24.4 MB without de-duplication) | 5,000 cards per run |
| Process memory, render plus merge, 5,000 cards | ≤ 0.9 GB | — |

## Vercel validation checklist (to do; requires approval)

Use a **Preview** deployment and a test workspace with **synthetic** registrations only. Do not use real attendee data.

1. [ ] **Batch timing:** on Preview, render one 198-card branded batch. Record the time. It must stay well under the 45 s budget and the 60 s limit.
2. [ ] **Response size:** confirm that a batch of about 1 MB and a 4 MiB response both download without the platform truncating or rejecting them. Confirm the plan's response-size limit.
3. [ ] **Memory:** read the function memory while rendering a batch and a 500-card single download, and compare it with the plan's limit.
4. [ ] **Planning at full size:** plan a 5,000-card run. It reads 5,000 registrations and checks text fit. Record the time against the 60 s limit.
5. [ ] **Browser merge:** on a typical organizer laptop, merge a 5,000-card run in Chrome. Record the time and memory, and check the PDF opens and prints correctly at 100 % scale.
6. [ ] **Physical print:** print one A4 and one A3 sheet at 100 %. Measure one card against its intended size (CR80 is 54 × 85.6 mm), check the crop marks, and check the QR code scans.
7. [ ] **Cron:** after the workflow change reaches the default branch, trigger `print-runs-reconcile` manually (`workflow_dispatch` on Group D). Confirm it returns `{ scanned, expired }` and changes only stale planned runs.
8. [ ] **Fonts:** if any event uses non-Latin names, confirm that `certificate-fonts/*.ttf`, or `CERT_FONT_*_URL`, is available on Vercel.
9. [ ] **Roles:** sign in as a manager, finance user and gate staff on Preview, and confirm Print & Assets is hidden from them and its APIs refuse them.

## Open risks

- **Untested on Vercel:** every limit above is a local measurement.
- **Strict runs:** a single cancellation or refund between planning and rendering fails the whole run, and the organizer has to start again. This is deliberate, so a card is never silently dropped.
- **Abandoned runs:** they show as "In progress" until 24 h of inactivity has passed.
- **Overflowing text:** it is reported, but the card still prints with the text cut off at the card's edge.
- **Merge time:** de-duplication adds about 3 s to the browser merge of a 5,000-card run.
- **Sweep size:** the reconciliation reaches at most 500 planned runs per day. Anything beyond that is still expired the next time it is read.
- **Unrelated test:** `photoCapacity.emu` stress test fails intermittently (emulator transaction lock timeouts). It is outside Print & Assets.
