// RD-RACEOPS-01 Sprint 2 · CSV provider.

import { readCsvText } from './readCsvText'
import { tabulate } from '../tabulate'
import { extensionOf, type ParseOutcome, type ResultFileSource, type ResultParser } from '../types'

export const CSV_PROVIDER_ID = 'csv'

export const csvParser: ResultParser = {
  id:         CSV_PROVIDER_ID,
  label:      'CSV',
  extensions: ['.csv'],

  supports(file) {
    return this.extensions.includes(extensionOf(file.name))
  },

  async parse(file: ResultFileSource): Promise<ParseOutcome> {
    if (!file.text) {
      return { ok: false, message: 'This file could not be read as text. Please re-export it as CSV and try again.' }
    }

    let text: string
    try {
      text = await file.text()
    } catch {
      return { ok: false, message: 'This file could not be read. It may have been moved or is still downloading — try selecting it again.' }
    }

    if (text.trim() === '') {
      return { ok: false, message: 'This file is empty — there is nothing to import.' }
    }

    return tabulate(readCsvText(text), { provider: CSV_PROVIDER_ID, sheetName: null })
  },
}
