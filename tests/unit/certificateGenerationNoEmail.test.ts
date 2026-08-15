// RD-CERT-EMAIL-BULK — GENERATION NEVER SENDS EMAIL.
//
// Issuing a certificate and delivering it used to be one operation: single generation
// honoured settings.autoEmail, and a bulk job carried its own autoEmail flag. That coupling
// caused three problems this file exists to prevent coming back:
//
//   • delivery could not be retried without regenerating the certificate;
//   • a delivery failure was invisible in a job whose counts describe certificates created;
//   • at bulk scale it charged an unbounded provider wait to the generation budget.
//
// Delivery is now an explicit action from Recipients. These tests assert the ABSENCE of a
// side effect, which is exactly the kind of behaviour that regresses silently.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const generate = readFileSync('lib/certificates/generate.ts', 'utf8')
const jobs     = readFileSync('lib/certificates/jobs.ts', 'utf8')
const panel    = readFileSync('components/certificates/hub/IssueBulkPanel.tsx', 'utf8')

describe('single generation does not send email', () => {
  it('never calls emailCertificate', () => {
    // The import is gone too — the module simply has no path to the email engine.
    expect(generate).not.toMatch(/emailCertificate\(/)
  })

  it('does not read settings.autoEmail as a send trigger', () => {
    expect(generate).not.toMatch(/autoEmail\.enabled/)
  })
})

describe('bulk generation does not send email', () => {
  it('the job worker never calls emailCertificate', () => {
    expect(jobs).not.toMatch(/emailCertificate\(/)
  })

  it('job.autoEmail is no longer read as a trigger', () => {
    expect(jobs).not.toMatch(/if \(job\.autoEmail\)/)
  })
})

describe('the generation UI offers no delivery control', () => {
  it('has no auto-email toggle', () => {
    expect(panel).not.toMatch(/autoEmail/)
  })

  it('points the operator at Recipients instead', () => {
    expect(panel).toMatch(/Recipients/)
  })
})

describe('settings keep the email CONTENT configuration', () => {
  it('autoEmail subject/message remain in the settings model', () => {
    const types = readFileSync('lib/certificates/types.ts', 'utf8')
    expect(types).toMatch(/autoEmail/)
  })

  it('and the default stays OFF', () => {
    const types = readFileSync('lib/certificates/types.ts', 'utf8')
    // defaultCertificateSettings() → autoEmail.enabled: false
    expect(types).toMatch(/autoEmail:\s*\{[\s\S]{0,80}enabled:\s*false/)
  })
})
