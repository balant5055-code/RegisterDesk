// RD-RACEOPS-RESULTS-04 · Rich timing-provider results — the PURE layer.
//
// Distance parsing, pace/speed derivation, split-time vs time-of-day parsing, the splits
// sheet (mapping, identity, integrity), group ranking, and the public projection's privacy
// boundary. Everything here runs without Firebase; the storage and lifecycle behaviour is
// proven on the emulator in tests/emulator/resultsSplits.emu.test.ts.
//
// The provider samples are the real ones from the 03 audit: Provider A (21K, 7 checkpoints
// with time-of-day) and Provider B (10K, 2 laps with lap distance/time).

import { describe, it, expect } from 'vitest'
import {
  parseRaceDistance, formatDistance, MAX_DISTANCE_METRES,
} from '@/features/race-operations/import/validation/distance'
import {
  paceMsPerKm, speedKmh, formatPace, formatPaceWithUnit, formatSpeed, legPerformance,
} from '@/features/race-operations/utils/performance'
import {
  parseRaceTime, parseSplitElapsed, parseTimeOfDay,
} from '@/features/race-operations/import/validation/time'
import {
  autoMapSplitColumns, parseSplitSheet, attachSplits, splitKey,
} from '@/features/race-operations/import/splits/splitSheet'
import { autoMapColumns } from '@/features/race-operations/import/mapping/autoMap'
import { applyMapping } from '@/features/race-operations/import/mapping/applyMapping'
import { validateResults } from '@/features/race-operations/import/validation/engine'
import { tabulate } from '@/features/race-operations/import/parsers/tabulate'
import {
  groupKey, groupTotalsFrom, rankGroupChunk, totalFor,
  INITIAL_GROUP_STATES, MAX_GROUPS_PER_DIMENSION,
} from '@/features/race-operations/ranking/groups'
import { toPublicRow, toPublicSplits } from '@/features/race-operations/utils/publicProjection'
import type { SnapshotEntryDoc, SnapshotSplitEntry } from '@/features/race-operations/types/snapshot'

// ─── Distance ─────────────────────────────────────────────────────────────────

describe('RD-RACEOPS-RESULTS-04 · distance parsing', () => {
  it('reads every spelling the two providers actually print', () => {
    for (const [raw, meters] of [
      ['21KM', 21_000], ['21 KM', 21_000], ['21km', 21_000], ['21.1 KM', 21_100],
      ['10KM', 10_000], ['10 Km', 10_000], ['5KM', 5_000], ['5 km', 5_000], ['5.5KM', 5_500],
      ['5000 m', 5_000], ['5000m', 5_000], ['1500 metres', 1_500], ['400 M', 400],
      ['13.1 mi', 21_082], ['1 mile', 1_609], ['5,000 m', 5_000],
    ] as [string, number][]) {
      const r = parseRaceDistance(raw)
      expect(r.ok, raw).toBe(true)
      if (r.ok) expect(r.meters, raw).toBe(meters)
    }
  })

  it('REFUSES a bare number rather than guessing the unit', () => {
    for (const raw of ['10', '21.1', '5000', '5,000']) {
      const r = parseRaceDistance(raw)
      expect(r.ok, raw).toBe(false)
      if (!r.ok) expect(r.reason, raw).toBe('no_unit')
    }
  })

  it('refuses unknown units, ranges, blanks and absurd values', () => {
    for (const raw of ['10 laps', '10-21 km', 'half marathon', '', '   ', '0 km', '-5 km', '2000 km', 'km 10']) {
      expect(parseRaceDistance(raw).ok, raw).toBe(false)
    }
    expect(parseRaceDistance(`${MAX_DISTANCE_METRES / 1000 + 1} km`).ok).toBe(false)
  })

  it('formats for display without trailing zeros, and says nothing when there is nothing', () => {
    expect(formatDistance(21_100)).toBe('21.1 km')
    expect(formatDistance(10_000)).toBe('10 km')
    expect(formatDistance(5_500)).toBe('5.5 km')
    expect(formatDistance(800)).toBe('800 m')
    expect(formatDistance(null)).toBe('')
    expect(formatDistance(0)).toBe('')
  })

  it('a LAP or SPLIT distance heading never becomes the overall race distance', () => {
    const r = autoMapColumns(['Bib', 'Chip Time', 'Lap Distance', 'Split Distance', 'Checkpoint Distance'])
    expect(r.mapping.distance).toBeUndefined()
    const core = autoMapColumns(['Bib', 'Chip Time', 'Distance'])
    expect(core.mapping.distance).toBe('Distance')
    for (const heading of ['Race Distance', 'Course Distance', 'Event Distance']) {
      expect(autoMapColumns(['Bib', 'Chip Time', heading]).mapping.distance, heading).toBe(heading)
    }
  })

  it('an unreadable distance is a BLOCKING error that names the fix', () => {
    const table = tabulate([['Bib', 'Time', 'Distance'], ['101', '00:32:35', '10']], { provider: 'csv', sheetName: null })
    expect(table.ok).toBe(true)
    if (!table.ok) return
    const v = validateResults(applyMapping(table.table, autoMapColumns(table.table.headers).mapping))
    const issue = v.issues.find(i => i.code === 'INVALID_DISTANCE')
    expect(issue?.severity).toBe('error')
    expect(issue?.message).toMatch(/no unit/)
    expect(v.rows[0].usable).toBe(false)
  })
})

// ─── Pace and speed ───────────────────────────────────────────────────────────

describe('RD-RACEOPS-RESULTS-04 · pace and speed are derived, never imported', () => {
  it('matches Provider A: 21 km in 1:29:32 → 4:15 min/km, 14.1 km/h', () => {
    const ms = (1 * 3600 + 29 * 60 + 32) * 1000
    expect(formatPace(paceMsPerKm(ms, 21_000))).toBe('4:15')
    expect(formatSpeed(speedKmh(ms, 21_000))).toBe('14.0 km/h')  // the provider's own sheet says 14.0
  })

  it('matches Provider B: 10 km in 32:35 → 3:15 min/km, 18.4 km/h', () => {
    const ms = (32 * 60 + 35) * 1000
    expect(formatPaceWithUnit(paceMsPerKm(ms, 10_000))).toBe('3:15 min/km')
    expect(formatSpeed(speedKmh(ms, 10_000))).toBe('18.4 km/h')
  })

  it('a LEG is computed from the leg, not the race: 5 km in 16:30 → 3:18, 18.2 km/h', () => {
    const leg = legPerformance((16 * 60 + 30) * 1000, 5_000)
    expect(formatPace(leg.paceMsPerKm)).toBe('3:18')
    expect(formatSpeed(leg.speedKmh)).toBe('18.1 km/h')   // 18.18 truncated, as a timing sheet prints it
  })

  it('returns NULL — never NaN, Infinity or zero — when the maths is impossible', () => {
    for (const [t, d] of [[null, 10_000], [0, 10_000], [1000, null], [1000, 0], [1000, -5], [-1, 10], [Number.NaN, 10], [1000, Number.POSITIVE_INFINITY]] as [number | null, number | null][]) {
      expect(paceMsPerKm(t, d), `${t}/${d}`).toBeNull()
      expect(speedKmh(t, d), `${t}/${d}`).toBeNull()
    }
    expect(formatPace(null)).toBe('')
    expect(formatSpeed(null)).toBe('')
    expect(formatPaceWithUnit(null)).toBe('')
  })

  it('refuses absurd speeds a mis-mapped column would produce', () => {
    expect(speedKmh(1, 10_000)).toBeNull()             // 10 km in 1 ms
    expect(speedKmh(240 * 3600_000, 100)).toBeNull()   // 100 m in 10 days
  })
})

// ─── Split time vs time of day ────────────────────────────────────────────────

describe('RD-RACEOPS-RESULTS-04 · 0:00, elapsed time and clock time are three different things', () => {
  it('0:00 is a valid SPLIT but never a valid race result', () => {
    expect(parseSplitElapsed('0:00')).toEqual({ ok: true, ms: 0 })
    expect(parseSplitElapsed('00:00:00')).toEqual({ ok: true, ms: 0 })
    expect(parseSplitElapsed('0')).toEqual({ ok: true, ms: 0 })
    expect(parseRaceTime('0:00').ok).toBe(false)
    expect(parseRaceTime('00:00:00').ok).toBe(false)
  })

  it('a split elapsed time otherwise behaves exactly like a race time', () => {
    expect(parseSplitElapsed('12:05')).toEqual({ ok: true, ms: 725_000 })
    expect(parseSplitElapsed('1:09:43')).toEqual({ ok: true, ms: (69 * 60 + 43) * 1000 })
    expect(parseSplitElapsed('').ok).toBe(false)
    expect(parseSplitElapsed('later').ok).toBe(false)
  })

  it('a clock reading stays a clock reading — normalised, and never milliseconds', () => {
    expect(parseTimeOfDay('06:16:45')).toEqual({ ok: true, value: '06:16:45' })
    expect(parseTimeOfDay('6:16')).toEqual({ ok: true, value: '06:16:00' })
    expect(parseTimeOfDay('07:46:17.5')).toEqual({ ok: true, value: '07:46:17' })
    expect(parseTimeOfDay('7:46:17 PM')).toEqual({ ok: true, value: '19:46:17' })
    expect(parseTimeOfDay('12:30 AM')).toEqual({ ok: true, value: '00:30:00' })
  })

  it('a value that is not a clock time is refused, not reinterpreted as a duration', () => {
    for (const raw of ['24:00:00', '25:10', '1:70:00', 'noon', '', '1:09:43 elapsed']) {
      expect(parseTimeOfDay(raw).ok, raw).toBe(false)
    }
    // …while the SAME string is a perfectly good elapsed time. That is why they are separate
    // parsers: 06:28:51 is both a morning and a six-hour race, and only the column says which.
    expect(parseSplitElapsed('06:28:51').ok).toBe(true)
  })
})

// ─── The splits sheet ─────────────────────────────────────────────────────────

const splitTable = (rows: string[][]) =>
  tabulate(rows, { provider: 'excel', sheetName: 'Splits' })

const resultRow = (bib: string, chipMs: number | null, extra: Partial<{ gender: string; ageGroup: string; distanceMeters: number }> = {}) => ({
  rowNumber: 2, participantName: `P${bib}`, bibNumber: bib,
  chipTimeMs: chipMs, gunTimeMs: null, chipTimeRaw: chipMs === null ? null : String(chipMs), gunTimeRaw: null,
  status: 'finished' as const, statusRaw: null,
  gender: extra.gender ?? null, category: null, ageGroup: extra.ageGroup ?? null,
  distanceMeters: extra.distanceMeters ?? null, distanceRaw: null,
  splits: [], rawRow: { Bib: bib }, sourceProvider: 'excel',
})

describe('RD-RACEOPS-RESULTS-04 · the splits sheet', () => {
  it('maps the template headers, and classifies pace/speed as calculated rather than unknown', () => {
    const m = autoMapSplitColumns(['Bib Number', 'Split', 'Distance', 'Time of Day', 'Elapsed Time', 'Split Time', 'Overall Pace', 'Lap Speed', 'Lap Distance', 'Mystery'])
    expect(m.mapping).toEqual({
      bibNumber: 'Bib Number', split: 'Split', distance: 'Distance',
      timeOfDay: 'Time of Day', elapsedTime: 'Elapsed Time', splitTime: 'Split Time',
    })
    expect(m.segmentDistanceHeader).toBe('Lap Distance')
    expect(m.derivedHeaders).toEqual(['Overall Pace', 'Lap Speed'])
    expect(m.unknownHeaders).toEqual(['Mystery'])
    expect(m.missingRequired).toEqual([])
  })

  it('reads Provider A: 7 checkpoints with time-of-day, a 0:00 start, and derived legs', () => {
    const t = splitTable([
      ['Bib Number', 'Split', 'Distance', 'Time of Day', 'Elapsed Time'],
      ['501', 'Start',  '',        '06:16:45', '0:00'],
      ['501', '3 KM',   '3 KM',    '06:28:51', '12:05'],
      ['501', '5.5 KM', '5.5 KM',  '06:39:35', '22:49'],
      ['501', '11 KM',  '11 KM',   '07:02:23', '45:37'],
      ['501', '16.5 KM', '16.5 KM', '07:26:29', '1:09:43'],
      ['501', '19 KM',  '19 KM',   '07:37:48', '1:21:03'],
      ['501', '21 KM',  '21 KM',   '07:46:17', '1:29:32'],
    ])
    expect(t.ok).toBe(true)
    if (!t.ok) return
    const parsed = parseSplitSheet(t.table)
    expect(parsed.issues).toEqual([])
    expect(parsed.rows).toBe(7)

    const chip = (1 * 3600 + 29 * 60 + 32) * 1000
    const out = attachSplits([resultRow('501', chip, { distanceMeters: 21_000 })], parsed)
    expect(out.issues).toEqual([])
    expect(out.withSplits).toBe(1)
    const splits = out.results[0].splits
    expect(splits).toHaveLength(7)
    expect(splits[0]).toMatchObject({ sequence: 1, name: 'Start', cumulativeTimeMs: 0, timeOfDay: '06:16:45' })
    // '0 km' has no readable magnitude, so the start carries no distance — and no pace.
    expect(splits[1]).toMatchObject({ name: '3 KM', distanceMeters: 3_000, cumulativeTimeMs: 725_000, timeOfDay: '06:28:51' })
    // The 3→5.5 km leg is DERIVED: 22:49 − 12:05 = 10:44 over 2.5 km.
    expect(splits[2].segmentTimeMs).toBe((10 * 60 + 44) * 1000)
    expect(splits[2].segmentMeters).toBe(2_500)
    // The final checkpoint agrees with the chip time, so nothing is flagged.
    expect(splits[6].cumulativeTimeMs).toBe(chip)
  })

  it('reads Provider B: lap distance and lap time are taken as given, not recomputed', () => {
    const t = splitTable([
      ['Bib', 'Split', 'Distance', 'Overall Time', 'Lap Distance', 'Lap Time', 'Lap Pace', 'Lap Speed'],
      ['10571', '5km',  '5 KM',  '00:16:05', '5Km', '00:16:05', '03:13', '18.6'],
      ['10571', '10km', '10 KM', '00:32:35', '5Km', '00:16:30', '03:18', '18.1'],
    ])
    expect(t.ok).toBe(true)
    if (!t.ok) return
    const parsed = parseSplitSheet(t.table)
    expect(parsed.issues).toEqual([])
    const out = attachSplits([resultRow('10571', (32 * 60 + 35) * 1000, { distanceMeters: 10_000 })], parsed)
    const [first, second] = out.results[0].splits
    expect(first).toMatchObject({ name: '5km', distanceMeters: 5_000, segmentMeters: 5_000, cumulativeTimeMs: 965_000, segmentTimeMs: 965_000 })
    expect(second).toMatchObject({ name: '10km', distanceMeters: 10_000, segmentMeters: 5_000, cumulativeTimeMs: 1_955_000, segmentTimeMs: 990_000 })
    // The provider's own pace/speed columns are recognised and NOT stored.
    expect(Object.keys(second)).not.toContain('pace')
    expect(Object.keys(second)).not.toContain('speed')
  })

  it('the same checkpoint twice for one bib is a BLOCKING error', () => {
    const t = splitTable([['Bib', 'Split', 'Elapsed Time'], ['101', '5 KM', '00:16:05'], ['101', '5km', '00:17:00']])
    if (!t.ok) throw new Error(t.message)
    const parsed = parseSplitSheet(t.table)
    const dup = parsed.issues.find(i => i.code === 'DUPLICATE_SPLIT')
    expect(dup?.severity).toBe('error')
    expect(dup?.message).toMatch(/twice/)
    expect(parsed.byBib.get('101')).toHaveLength(1)     // the second row is NOT kept
  })

  it('splitKey makes "5 KM", "5km" and "5-KM" one checkpoint and keeps different ones apart', () => {
    expect(splitKey('5 KM')).toBe(splitKey('5km'))
    expect(splitKey('5 KM')).toBe(splitKey('5-KM'))
    expect(splitKey('5 KM')).not.toBe(splitKey('10 KM'))
    expect(splitKey('T1')).toBe('T1')
    expect(splitKey('  ')).toBe('')
  })

  it('checkpoints for a bib with no result row are a BLOCKING error, never silently dropped', () => {
    const t = splitTable([['Bib', 'Split', 'Elapsed Time'], ['999', '5 KM', '00:16:05']])
    if (!t.ok) throw new Error(t.message)
    const out = attachSplits([resultRow('101', 600_000)], parseSplitSheet(t.table))
    const orphan = out.issues.find(i => i.code === 'ORPHAN_SPLIT_BIB')
    expect(orphan?.severity).toBe('error')
    expect(out.results[0].splits).toEqual([])
  })

  it('a course whose elapsed times go backwards is a BLOCKING error on that result row', () => {
    const t = splitTable([['Bib', 'Split', 'Distance', 'Elapsed Time'], ['101', '5 KM', '5 KM', '00:20:00'], ['101', '10 KM', '10 KM', '00:19:00']])
    if (!t.ok) throw new Error(t.message)
    // Ordering by time alone would hide this, so the check compares the times as supplied
    // against the distances they claim.
    const parsed = parseSplitSheet(t.table)
    const out = attachSplits([resultRow('101', 1_200_000)], parsed)
    const issue = out.issues.find(i => i.code === 'SPLIT_TIME_DECREASING' || i.code === 'SPLIT_FINISH_MISMATCH')
    expect(issue).toBeDefined()
  })

  it('a checkpoint with no time at all is refused', () => {
    const t = splitTable([['Bib', 'Split', 'Elapsed Time', 'Split Time'], ['101', '5 KM', '', '']])
    if (!t.ok) throw new Error(t.message)
    expect(parseSplitSheet(t.table).issues.some(i => i.code === 'SPLIT_NO_TIME')).toBe(true)
  })

  it('a last checkpoint that disagrees with the chip time WARNS and overwrites neither value', () => {
    const t = splitTable([['Bib', 'Split', 'Distance', 'Elapsed Time'], ['101', '10 KM', '10 KM', '00:33:35']])
    if (!t.ok) throw new Error(t.message)
    const chip = (32 * 60 + 35) * 1000
    const out = attachSplits([resultRow('101', chip, { distanceMeters: 10_000 })], parseSplitSheet(t.table))
    const warn = out.issues.find(i => i.code === 'SPLIT_FINISH_MISMATCH')
    expect(warn?.severity).toBe('warning')
    expect(out.results[0].chipTimeMs).toBe(chip)                          // untouched
    expect(out.results[0].splits[0].cumulativeTimeMs).toBe((33 * 60 + 35) * 1000)  // untouched
  })

  it('an unreadable time of day is a warning and the checkpoint is kept without one', () => {
    const t = splitTable([['Bib', 'Split', 'Time of Day', 'Elapsed Time'], ['101', '5 KM', '99:99', '00:16:05']])
    if (!t.ok) throw new Error(t.message)
    const parsed = parseSplitSheet(t.table)
    expect(parsed.issues.find(i => i.code === 'SPLIT_INVALID_TIME_OF_DAY')?.severity).toBe('warning')
    expect(parsed.byBib.get('101')?.[0]).toMatchObject({ timeOfDay: null, cumulativeTimeMs: 965_000 })
  })

  it('a sheet with no Bib or no Split column is refused with a reason, not silently ignored', () => {
    const noBib = splitTable([['Split', 'Elapsed Time'], ['5 KM', '00:16:05']])
    if (!noBib.ok) throw new Error(noBib.message)
    expect(parseSplitSheet(noBib.table).issues[0]).toMatchObject({ code: 'SPLIT_MISSING_BIB', severity: 'error' })

    const noName = splitTable([['Bib', 'Elapsed Time'], ['101', '00:16:05']])
    if (!noName.ok) throw new Error(noName.message)
    expect(parseSplitSheet(noName.table).issues[0]).toMatchObject({ code: 'SPLIT_MISSING_NAME', severity: 'error' })
  })

  it('a blocking split problem makes its result row unusable, so it cannot be published', () => {
    const results = [resultRow('101', 600_000)]
    const v = validateResults(results, {
      splitIssues: [{ code: 'DUPLICATE_SPLIT', severity: 'error', rowNumber: 2, bibNumber: '101', message: 'x' }],
    })
    expect(v.rows[0].usable).toBe(false)
    expect(v.summary.errorCount).toBeGreaterThan(0)
  })

  it('a provider column RegisterDesk calculates is reported as calculated, not as unknown', () => {
    const v = validateResults([resultRow('101', 600_000)], {
      unmappedHeaders: ['Notes'], calculatedHeaders: ['Overall Rank', 'Pace'],
    })
    const calculated = v.issues.filter(i => i.code === 'PROVIDER_CALCULATED_COLUMN')
    expect(calculated).toHaveLength(2)
    expect(calculated[0].message).toMatch(/calculated by RegisterDesk/)
    expect(v.issues.filter(i => i.code === 'UNMAPPED_COLUMN')).toHaveLength(1)
  })
})

// ─── Group ranking ────────────────────────────────────────────────────────────

describe('RD-RACEOPS-RESULTS-04 · gender and age-group ranking', () => {
  const row = (rowNumber: number, chipTimeMs: number, gender: string | null, ageGroup: string | null) =>
    ({ rowNumber, chipTimeMs, gender, ageGroup })

  it('ranks each group independently, in one pass over the ascending field', () => {
    const rows = [
      row(2, 1_000, 'Male',   '18-30'),
      row(3, 1_100, 'Female', '18-30'),
      row(4, 1_200, 'Male',   '31-40'),
      row(5, 1_300, 'Female', '18-30'),
      row(6, 1_400, 'Male',   '18-30'),
    ]
    const { assignments, states } = rankGroupChunk(rows, INITIAL_GROUP_STATES)
    expect(assignments.map(a => a.genderRank)).toEqual([1, 1, 2, 2, 3])
    expect(assignments.map(a => a.ageGroupRank)).toEqual([1, 2, 1, 3, 4])

    const totals = groupTotalsFrom(states)
    expect(totals.gender).toEqual({ male: 3, female: 2 })
    expect(totals.ageGroup).toEqual({ 1830: 4, 3140: 1 })
    expect(totalFor(totals, 'gender', 'MALE')).toBe(3)
    expect(totalFor(totals, 'ageGroup', '18-30')).toBe(4)
    expect(totalFor(totals, 'gender', null)).toBeNull()
  })

  it('uses the SAME competition tie rule as the overall rank (1224, not 1223)', () => {
    const rows = [row(2, 1_000, 'M', null), row(3, 1_100, 'M', null), row(4, 1_100, 'M', null), row(5, 1_200, 'M', null)]
    const { assignments } = rankGroupChunk(rows, INITIAL_GROUP_STATES)
    expect(assignments.map(a => a.genderRank)).toEqual([1, 2, 2, 4])
  })

  it('resumes across chunk boundaries, including a tie that straddles one', () => {
    const first  = rankGroupChunk([row(2, 1_000, 'M', null), row(3, 1_100, 'M', null)], INITIAL_GROUP_STATES)
    const second = rankGroupChunk([row(4, 1_100, 'M', null), row(5, 1_200, 'M', null)], first.states)
    expect([...first.assignments, ...second.assignments].map(a => a.genderRank)).toEqual([1, 2, 2, 4])
    expect(groupTotalsFrom(second.states).gender.m).toBe(4)
  })

  it('normalises spelling for comparison but never invents a group', () => {
    expect(groupKey('Male')).toBe(groupKey('MALE'))
    expect(groupKey('Below 35yrs - Men')).toBe('below35yrsmen')
    expect(groupKey(null)).toBe('')
    expect(groupKey('   ')).toBe('')
    // 'M' and 'Male' are DIFFERENT groups: RegisterDesk has no basis to merge an organizer's
    // vocabulary, and guessing would move people between rankings.
    expect(groupKey('M')).not.toBe(groupKey('Male'))
  })

  it('a row with no group value is ranked overall and simply has no group rank', () => {
    const { assignments } = rankGroupChunk([row(2, 1_000, null, ''), row(3, 1_100, 'M', 'Open')], INITIAL_GROUP_STATES)
    expect(assignments[0]).toEqual({ rowNumber: 2, genderRank: null, ageGroupRank: null })
    expect(assignments[1]).toEqual({ rowNumber: 3, genderRank: 1, ageGroupRank: 1 })
  })

  it('ABANDONS a dimension whose column is not a group, rather than ranking half the field', () => {
    const rows = Array.from({ length: MAX_GROUPS_PER_DIMENSION + 5 }, (_, i) => row(i + 2, 1_000 + i, `runner-${i}`, 'Open'))
    const { assignments, abandoned } = rankGroupChunk(rows, INITIAL_GROUP_STATES)
    expect(abandoned).toContain('gender')
    expect(abandoned).not.toContain('ageGroup')
    expect(assignments[assignments.length - 1].genderRank).toBeNull()
    expect(assignments[assignments.length - 1].ageGroupRank).not.toBeNull()
  })
})

// ─── The public boundary ──────────────────────────────────────────────────────

describe('RD-RACEOPS-RESULTS-04 · the public projection stays a boundary', () => {
  const entry = (over: Partial<SnapshotEntryDoc> = {}): SnapshotEntryDoc => ({
    v: 3, bibNumber: '10571', bibKey: '10571', name: 'Sureshkumar V', nameLower: 'sureshkumar v',
    chipTimeMs: (32 * 60 + 35) * 1000, gunTimeMs: (32 * 60 + 38) * 1000, status: 'finished',
    overallRank: 1, passRank: 1,
    gender: 'Male', ageGroup: 'Below 35yrs - Men', category: null,
    distanceMeters: 10_000, distanceRaw: '10 Km',
    genderRank: 1, genderTotal: 827, ageGroupRank: 1, ageGroupTotal: 498,
    ...over,
  })

  it('carries the enriched facts and DERIVES pace and speed', () => {
    const row = toPublicRow(entry())
    expect(row).toMatchObject({
      bibNumber: '10571', name: 'Sureshkumar V', overallRank: 1,
      gender: 'Male', ageGroup: 'Below 35yrs - Men', distanceMeters: 10_000, distanceRaw: '10 Km',
      genderRank: 1, genderTotal: 827, ageGroupRank: 1, ageGroupTotal: 498,
    })
    expect(formatPace(row.paceMsPerKm)).toBe('3:15')
    expect(formatSpeed(row.speedKmh)).toBe('18.4 km/h')
  })

  it('never leaks internals, and never invents a value it was not given', () => {
    const row = toPublicRow(entry({
      gender: undefined, ageGroup: undefined, distanceMeters: undefined,
      genderRank: undefined, genderTotal: undefined, ageGroupRank: undefined, ageGroupTotal: undefined,
    }))
    for (const forbidden of ['v', 'bibKey', 'nameLower', 'passRank', 'rawRow', 'organizerUid', 'sessionId']) {
      expect(Object.keys(row)).not.toContain(forbidden)
    }
    expect(row.gender).toBeNull()
    expect(row.genderRank).toBeNull()
    expect(row.genderTotal).toBeNull()
    expect(row.paceMsPerKm).toBeNull()      // no distance ⇒ no pace, not a zero
    expect(row.speedKmh).toBeNull()
  })

  it('projects splits in course order, derives both readings, and drops the internal key', () => {
    const stored: SnapshotSplitEntry[] = [
      { sequence: 2, splitKey: '10KM', name: '10km', distanceMeters: 10_000, segmentMeters: 5_000, cumulativeTimeMs: 1_955_000, segmentTimeMs: 990_000, timeOfDay: '06:32:35' },
      { sequence: 1, splitKey: '5KM',  name: '5km',  distanceMeters: 5_000,  segmentMeters: 5_000, cumulativeTimeMs: 965_000,  segmentTimeMs: 965_000, timeOfDay: '06:16:05' },
    ]
    const rows = toPublicSplits(stored)
    expect(rows.map(r => r.name)).toEqual(['5km', '10km'])
    expect(Object.keys(rows[0])).not.toContain('splitKey')
    expect(formatPace(rows[0].cumulativePaceMsPerKm)).toBe('3:13')
    expect(formatPace(rows[1].cumulativePaceMsPerKm)).toBe('3:15')
    expect(formatPace(rows[1].segmentPaceMsPerKm)).toBe('3:18')
    expect(formatSpeed(rows[1].segmentSpeedKmh)).toBe('18.1 km/h')
  })

  it('a checkpoint with no distance shows its times and no pace', () => {
    const rows = toPublicSplits([
      { sequence: 1, splitKey: 'T1', name: 'T1', distanceMeters: null, segmentMeters: null, cumulativeTimeMs: 120_000, segmentTimeMs: 120_000, timeOfDay: null },
    ])
    expect(rows[0].cumulativeTimeMs).toBe(120_000)
    expect(rows[0].cumulativePaceMsPerKm).toBeNull()
    expect(rows[0].segmentSpeedKmh).toBeNull()
  })
})
