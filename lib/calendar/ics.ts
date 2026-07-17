// RFC5545-compliant ICS generator for RegisterDesk events.
//
// All event dates are stored as local Indian Standard Time (IST, UTC+5:30).
// VTIMEZONE is embedded for timed events so calendar clients interpret times
// correctly regardless of the user's own timezone setting.

export interface IcsEventInput {
  uid:         string   // globally unique, e.g. "slug@registerdesk.in"
  title:       string
  description: string
  location:    string
  url:         string
  startDate:   string   // YYYY-MM-DD
  endDate:     string   // YYYY-MM-DD (same as startDate for single-day events)
  startTime:   string   // HH:MM or '' (empty = all-day event)
  endTime:     string   // HH:MM or ''
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeIcs(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

// RFC5545 §3.1: lines MUST be folded at 75 octets (CRLF + SPACE continuation).
function fold(line: string): string {
  if (line.length <= 75) return line
  const out: string[] = [line.slice(0, 75)]
  let pos = 75
  while (pos < line.length) {
    out.push(' ' + line.slice(pos, pos + 74))
    pos += 74
  }
  return out.join('\r\n')
}

function prop(name: string, value: string): string {
  return fold(`${name}:${value}`)
}

function localDateStr(dateStr: string, timeStr: string): string {
  const [y, m, d] = dateStr.split('-')
  if (!timeStr) return `${y}${m}${d}`   // all-day: VALUE=DATE
  const [h, min] = timeStr.split(':')
  return `${y}${m}${d}T${(h ?? '00').padStart(2, '0')}${(min ?? '00').padStart(2, '0')}00`
}

function utcNow(): string {
  const n = new Date()
  return (
    String(n.getUTCFullYear()) +
    String(n.getUTCMonth() + 1).padStart(2, '0') +
    String(n.getUTCDate()).padStart(2, '0') +
    'T' +
    String(n.getUTCHours()).padStart(2, '0') +
    String(n.getUTCMinutes()).padStart(2, '0') +
    String(n.getUTCSeconds()).padStart(2, '0') +
    'Z'
  )
}

// Compute DTEND for all-day events: day after the last day (RFC5545 exclusive).
function allDayEnd(lastDay: string): string {
  const [y, m, d] = lastDay.split('-').map(Number)
  const next = new Date(Date.UTC(y!, m! - 1, d! + 1))
  return (
    String(next.getUTCFullYear()) +
    String(next.getUTCMonth() + 1).padStart(2, '0') +
    String(next.getUTCDate()).padStart(2, '0')
  )
}

// Compute DTEND as 1 hour after start when no endTime is provided.
function oneHourAfter(dateStr: string, timeStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const [h, min]  = timeStr.split(':').map(Number)
  const dt = new Date(Date.UTC(y!, m! - 1, d!, (h ?? 0) - 5, (min ?? 0) - 30 + 60))
  // Convert back to IST local string (just add 5:30 to UTC)
  const ist = new Date(dt.getTime() + 5.5 * 60 * 60 * 1000)
  return (
    String(ist.getUTCFullYear()) +
    String(ist.getUTCMonth() + 1).padStart(2, '0') +
    String(ist.getUTCDate()).padStart(2, '0') +
    'T' +
    String(ist.getUTCHours()).padStart(2, '0') +
    String(ist.getUTCMinutes()).padStart(2, '0') +
    '00'
  )
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function generateIcs(input: IcsEventInput): string {
  const { uid, title, description, location, url, startDate, endDate, startTime, endTime } = input

  const isAllDay  = !startTime?.trim()
  const lastDay   = endDate?.trim() || startDate
  const dtStart   = localDateStr(startDate, startTime)
  const dtEnd     = isAllDay
    ? allDayEnd(lastDay)
    : endTime?.trim()
      ? localDateStr(lastDay, endTime)
      : oneHourAfter(startDate, startTime)

  const lines: string[] = []

  const push = (...s: string[]) => lines.push(...s)

  push('BEGIN:VCALENDAR')
  push('VERSION:2.0')
  push('PRODID:-//RegisterDesk//RegisterDesk//EN')
  push('CALSCALE:GREGORIAN')
  push('METHOD:PUBLISH')
  push(prop('X-WR-CALNAME', escapeIcs(title)))
  push('X-WR-TIMEZONE:Asia/Kolkata')

  // Embed VTIMEZONE for timed events so clients honour IST.
  if (!isAllDay) {
    push(
      'BEGIN:VTIMEZONE',
      'TZID:Asia/Kolkata',
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      'TZOFFSETFROM:+0530',
      'TZOFFSETTO:+0530',
      'TZNAME:IST',
      'END:STANDARD',
      'END:VTIMEZONE',
    )
  }

  push('BEGIN:VEVENT')
  push(prop('UID', uid))
  push(prop('DTSTAMP', utcNow()))

  if (isAllDay) {
    push(prop('DTSTART;VALUE=DATE', dtStart))
    push(prop('DTEND;VALUE=DATE', dtEnd))
  } else {
    push(prop('DTSTART;TZID=Asia/Kolkata', dtStart))
    push(prop('DTEND;TZID=Asia/Kolkata', dtEnd))
  }

  push(prop('SUMMARY', escapeIcs(title)))

  const desc = description?.trim()
  if (desc) push(prop('DESCRIPTION', escapeIcs(desc.slice(0, 500))))

  const loc = location?.trim()
  if (loc) push(prop('LOCATION', escapeIcs(loc)))

  const eventUrl = url?.trim()
  if (eventUrl) push(prop('URL', eventUrl))

  push('END:VEVENT')
  push('END:VCALENDAR')

  return lines.join('\r\n') + '\r\n'
}

// ─── Calendar link builders ───────────────────────────────────────────────────

export interface CalendarLinkInput {
  title:     string
  startDate: string   // YYYY-MM-DD
  endDate:   string   // YYYY-MM-DD
  startTime: string   // HH:MM or ''
  endTime:   string   // HH:MM or ''
  location:  string
  description: string
}

/** Google Calendar "add event" URL. Dates in YYYYMMDD[THHMMSS] local-IST format. */
export function googleCalendarUrl(input: CalendarLinkInput): string {
  const { title, startDate, endDate, startTime, endTime, location, description } = input
  const isAllDay = !startTime?.trim()
  const lastDay  = endDate?.trim() || startDate

  let dates: string
  if (isAllDay) {
    const endExclusive = allDayEnd(lastDay)
    dates = `${startDate.replace(/-/g, '')}/${endExclusive}`
  } else {
    const s = localDateStr(startDate, startTime)
    const e = endTime?.trim()
      ? localDateStr(lastDay, endTime)
      : oneHourAfter(startDate, startTime)
    dates = `${s}/${e}`
  }

  const params = new URLSearchParams({
    action:  'TEMPLATE',
    text:    title,
    dates,
    ...(location    ? { location }    : {}),
    ...(description ? { details: description.slice(0, 500) } : {}),
  })
  return `https://calendar.google.com/calendar/render?${params.toString()}`
}

/** Outlook Web App "add event" URL. Uses ISO-8601 local-IST strings. */
export function outlookCalendarUrl(input: CalendarLinkInput): string {
  const { title, startDate, endDate, startTime, endTime, location, description } = input
  const isAllDay = !startTime?.trim()
  const lastDay  = endDate?.trim() || startDate

  const startdt = isAllDay
    ? `${startDate}T00:00:00`
    : `${startDate}T${(startTime ?? '00:00').padStart(5, '0')}:00`
  const enddt   = isAllDay
    ? `${lastDay}T23:59:00`
    : endTime?.trim()
      ? `${lastDay}T${endTime.padStart(5, '0')}:00`
      : (() => {
          const [h, m] = (startTime ?? '00:00').split(':').map(Number)
          const e = new Date(0, 0, 0, h ?? 0, (m ?? 0) + 60)
          return `${startDate}T${String(e.getHours()).padStart(2,'0')}:${String(e.getMinutes()).padStart(2,'0')}:00`
        })()

  const params = new URLSearchParams({
    rru:     'addevent',
    subject: title,
    startdt,
    enddt,
    ...(location    ? { location }              : {}),
    ...(description ? { body: description.slice(0, 500) } : {}),
    path:    '/calendar/action/compose',
  })
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`
}
