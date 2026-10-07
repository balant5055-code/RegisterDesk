// RD-RACEOPS-RESULTS-07B · Section headings → gender / age-group context.
//
// PURE. No SDK, no provider names.
//
// ─── What this reads ─────────────────────────────────────────────────────────
// A real provider's age-group listing (RESULTS-07) does not print gender or age band as
// columns. It prints them as SECTION HEADINGS above the rows they govern, on lines of their
// own, and at two levels:
//
//   Male
//   16-25 Yrs
//     1  10120  …  49:36  07:09:56
//   26-45 Yrs
//     1  10136  …  47:39  07:08:00
//   46 Yrs & Above
//     …
//   Female
//   16-25 Yrs
//     …
//
// RESULTS-06 dropped those lines as stray captions, so every row published with
// gender = null and ageGroup = null while the facts sat in plain sight. Here a heading is
// recognised and carried onto the rows beneath it until the next heading of the same level
// replaces it. A gender heading also clears the age band, so the last band of one gender
// can never leak onto the first rows of the next.
//
// ─── What this refuses ───────────────────────────────────────────────────────
// A line is a section heading ONLY when, after the filler a provider prints beside a band
// ("Yrs", "Years", "Age Group", "&", "and"), NOTHING is left but a gender word and/or one
// age band. "10KM", "Results 10KM", a race title, a sponsor line: none of those parse, and a
// line that does not parse is left exactly as it was — never a row, never context. When in
// doubt the answer is null; a wrong gender on a public result is worse than a missing one.
//
// Gender is taken from whole words only ("Male", "Women"); a bare "M" or "F" is accepted
// solely when it accompanies an age band, because a one-letter line on its own is not
// evidence of anything.

export interface SectionHeading {
  gender:   string | null
  ageGroup: string | null
}

/** The context in force for the rows currently being read. */
export interface SectionContext {
  gender:   string | null
  ageGroup: string | null
}

export const EMPTY_SECTION_CONTEXT: Readonly<SectionContext> = { gender: null, ageGroup: null }

/**
 * Column headings appended to a table whose gender / age band came from section headings.
 * They carry "(section)" so the mapping step shows the organizer WHERE the value came from;
 * the mapper still resolves them to `gender` / `ageGroup` (as a review-level match).
 */
export const SECTION_GENDER_HEADER    = 'Gender (section)'
export const SECTION_AGE_GROUP_HEADER = 'Age Group (section)'

const GENDER_WORDS: Readonly<Record<string, string>> = {
  male: 'Male', men: 'Male', man: 'Male', boys: 'Male', boy: 'Male',
  female: 'Female', women: 'Female', woman: 'Female', girls: 'Female', girl: 'Female',
}
const GENDER_LETTERS: Readonly<Record<string, string>> = { m: 'Male', f: 'Female' }

/** Words a provider prints beside a band that carry no information of their own. */
const FILLER = new Set(['yrs', 'yr', 'years', 'year', 'age', 'group', 'agegroup', 'category', 'cat', 'and', '&'])

/** Age band spellings, each normalised to one canonical form. */
const AGE_BAND: readonly { re: RegExp; to: (m: RegExpMatchArray) => string }[] = [
  { re: /^(\d{1,3})\s*(?:-|–|—|to)\s*(\d{1,3})$/i,          to: m => `${m[1]}-${m[2]}` },   // 16-25, 16 to 25
  { re: /^(\d{1,3})\s*\+$/,                                  to: m => `${m[1]}+` },          // 46+
  { re: /^(\d{1,3})\s*(?:above|over|plus|andabove|andover)$/i, to: m => `${m[1]}+` },        // 46 & Above (after filler removal)
  { re: /^(?:above|over)\s*(\d{1,3})$/i,                     to: m => `${m[1]}+` },          // Above 46
  { re: /^(?:under|below|u)\s*(\d{1,3})$/i,                  to: m => `Under ${m[1]}` },     // Under 18, U18
]

/**
 * Reads one line as a section heading, or returns null when it is not one.
 *
 * "Male" → { gender: 'Male', ageGroup: null }
 * "16-25 Yrs" → { gender: null, ageGroup: '16-25' }
 * "46 Yrs & Above" → { gender: null, ageGroup: '46+' }
 * "Female 26-45" → { gender: 'Female', ageGroup: '26-45' }
 * "10KM" / "Results 10KM" / "Overall" → null
 */
export function parseSectionHeading(text: string): SectionHeading | null {
  const tokens = text.trim().toLowerCase().split(/\s+/).filter(t => t !== '')
  if (tokens.length === 0 || tokens.length > 6) return null

  let gender: string | null = null
  let letter: string | null = null
  const rest: string[] = []
  for (const raw of tokens) {
    const t = raw.replace(/[.,:;()]/g, '')
    if (t === '' || FILLER.has(t)) continue
    if (GENDER_WORDS[t] !== undefined) {
      if (gender !== null) return null            // two gender words ⇒ not a heading
      gender = GENDER_WORDS[t]
      continue
    }
    if (GENDER_LETTERS[t] !== undefined && letter === null) { letter = GENDER_LETTERS[t]; continue }
    rest.push(t)
  }

  // Whatever is left must be exactly one age band — or nothing.
  let ageGroup: string | null = null
  if (rest.length > 0) {
    const joined = rest.join('')
    const spaced = rest.join(' ')
    for (const band of AGE_BAND) {
      const m = spaced.match(band.re) ?? joined.match(band.re)
      if (m) { ageGroup = band.to(m); break }
    }
    if (ageGroup === null) return null
    // A band whose bounds are reversed ("25-16") is a typo or not a band at all.
    const range = ageGroup.match(/^(\d+)-(\d+)$/)
    if (range && Number(range[1]) >= Number(range[2])) return null
  }

  if (gender === null && letter !== null) {
    if (ageGroup === null) return null           // a bare "M" line proves nothing
    gender = letter
  } else if (letter !== null) {
    return null                                   // "Male F" — contradictory
  }

  if (gender === null && ageGroup === null) return null
  return { gender, ageGroup }
}

/**
 * The context after a heading: a gender heading opens a new gender section (and clears
 * the band, which the provider prints afresh underneath); a band heading replaces only the
 * band; a combined heading sets both.
 */
export function applySectionHeading(context: Readonly<SectionContext>, heading: SectionHeading): SectionContext {
  if (heading.gender !== null) {
    return { gender: heading.gender, ageGroup: heading.ageGroup }
  }
  return { gender: context.gender, ageGroup: heading.ageGroup }
}

/**
 * The age-group VALUE a row under this context carries: the section's full identity.
 *
 * A band printed beneath a gender heading is that gender's band — the provider's own
 * age-group rank restarts at 1 for "Male 26-45" and again for "Female 26-45", and so does
 * every race's age-group podium. RegisterDesk ranks the age-group dimension by the value
 * alone (ranking/groups.ts: "whatever the file said"), so the value must name the section,
 * not just the band, or the two genders' bands would be ranked as one group and the public
 * "4 / 6" would contradict the "1" the provider printed beside the same name.
 *
 * "Male" + "26-45" → "Male 26-45"; a band with no gender heading above it → "26-45".
 */
export function sectionAgeGroupValue(context: Readonly<SectionContext>): string | null {
  if (context.ageGroup === null) return null
  return context.gender === null ? context.ageGroup : `${context.gender} ${context.ageGroup}`
}
