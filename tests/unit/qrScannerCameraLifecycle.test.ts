// RD-CHECKIN-CAMERA-FIX-01 — the scanner releases the camera.
//
// ═══ THE BUG ═════════════════════════════════════════════════════════════════
// `startScanner` is async — it awaits a dynamic import and then
// `decodeFromVideoDevice`, which is where getUserMedia actually runs. The effect
// cleanup is synchronous. A start could therefore be superseded mid-flight (by the
// `cameraId` this component sets after enumerating devices, by `active` toggling on
// every admission, or by unmount) and cleanup would run with `controlsRef` still
// null and `srcObject` still unset — stopping nothing. The in-flight start then
// created a stream nothing held a reference to. Measured live: two getUserMedia
// calls, both tracks left `live`, camera indicator on after leaving the page.
//
// ═══ WHAT THESE TESTS ARE, AND ARE NOT ═══════════════════════════════════════
// These are SOURCE CONTRACTS. They pin the ordering that makes the fix correct —
// which is a structural property, and one a node-environment test can actually
// establish, since the component needs a real camera, a real MediaStream and a real
// DOM to run at all.
//
// They are deliberately NOT the proof that the camera turns off. That claim is only
// worth making from a browser, and it is made in scripts/qa/rd-checkin-10-device.mjs,
// which drives a real Chromium with a synthetic camera and asserts every track
// reaches `readyState === 'ended'`. If these contracts ever disagree with that
// harness, the harness is right.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const SRC  = read('components/checkin/QrScanner.tsx')
/** Comments stripped, so no assertion can be satisfied by prose ABOUT the code. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('{/*')).join('\n')

/** Body of startScanner, from its declaration to the closing of its useCallback. */
const START = (() => {
  const i = CODE.indexOf('const startScanner = useCallback(async () => {')
  const j = CODE.indexOf('}, [cameraId, onCode, stopScanner])', i)
  expect(i, 'startScanner not found').toBeGreaterThan(-1)
  expect(j, 'startScanner end not found').toBeGreaterThan(i)
  return CODE.slice(i, j)
})()

const STOP = (() => {
  const i = CODE.indexOf('const stopScanner = useCallback(() => {')
  const j = CODE.indexOf('}, [])', i)
  return CODE.slice(i, j)
})()

describe('RD-CHECKIN-CAMERA-FIX-01 · a superseded start cleans up after itself', () => {
  it('1 · each start captures a run token AFTER the counter is bumped', () => {
    // Captured after stopScanner() so this run is the current one; capturing before
    // would make every start immediately look superseded.
    const bump  = START.indexOf('stopScanner()')
    const token = START.indexOf('const myRun = runIdRef.current')
    expect(token).toBeGreaterThan(bump)
  })

  it('2 · the scanner result is gated BEFORE it is committed to the ref', () => {
    // The ordering that fixes the leak: decide whether this run still owns the
    // stream before handing it to a ref another run may already be using.
    const resolved = START.indexOf('await reader.decodeFromVideoDevice(')
    const gate     = START.indexOf('if (superseded()) {', resolved)
    const commit   = START.indexOf('controlsRef.current = controls', resolved)
    expect(resolved).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(resolved)
    expect(commit).toBeGreaterThan(gate)
  })

  it('3 · a superseded start STOPS the controls it created', () => {
    const gate = START.indexOf('if (superseded()) {')
    const body = START.slice(gate, START.indexOf('controlsRef.current = controls', gate))
    expect(body).toContain('controls.stop()')
    expect(body).toContain('return')
  })

  it('4 · a superseded start never assigns obsolete controls', () => {
    // The only assignment to controlsRef in this function sits after the gate, and
    // the gate returns — so there is no path that both supersedes and commits.
    const assignments = (START.match(/controlsRef\.current\s*=/g) ?? [])
    expect(assignments).toHaveLength(1)
    const gate   = START.indexOf('if (superseded()) {')
    const commit = START.indexOf('controlsRef.current = controls')
    expect(commit).toBeGreaterThan(gate)
  })

  it('5 · every later await is gated too, so no state is written by a dead run', () => {
    // Torch detection, the device re-list, and the error/finally paths.
    const gates = (START.match(/superseded\(\)/g) ?? []).length
    expect(gates).toBeGreaterThanOrEqual(5)
  })

  it('6 · the run token is bumped by stopScanner, which is what supersedes a start', () => {
    expect(STOP).toContain('runIdRef.current += 1')
  })
})

describe('RD-CHECKIN-CAMERA-FIX-01 · cleanup can reach an orphan', () => {
  it('7 · stopScanner sweeps zxing\'s own stream registry', () => {
    // controlsRef holds one set of controls and srcObject holds one stream, so a
    // stream orphaned by an earlier race is unreachable through either. zxing's
    // static registry is the only place it still exists.
    expect(STOP).toContain('releaseAllStreams()')
  })

  it('8 · the existing cleanup is retained, not replaced', () => {
    expect(STOP).toContain('controlsRef.current?.stop()')
    expect(STOP).toContain('controlsRef.current = null')
    expect(STOP).toContain('getTracks().forEach(t => t.stop())')
    expect(STOP).toContain('srcObject = null')
  })

  it('9 · the sweeper is callable synchronously — cleanup cannot await', () => {
    // A React effect cleanup must be synchronous, so the reader class is captured
    // when the module loads rather than imported inside stopScanner.
    expect(CODE).toContain('readerRef.current = BrowserMultiFormatReader')
    expect(STOP).not.toContain('await')
    expect(STOP).not.toContain('import(')
  })

  it('10 · the effect still returns stopScanner as its cleanup', () => {
    expect(CODE).toMatch(/return stopScanner\s*\n/)
  })

  it('11 · the video element is captured before the first await', () => {
    // So cleanup does not depend on the React ref still being attached.
    const capture = START.indexOf('const video = videoRef.current')
    const firstAwait = START.indexOf('await ')
    expect(capture).toBeGreaterThan(-1)
    expect(capture).toBeLessThan(firstAwait)
  })
})

describe('RD-CHECKIN-CAMERA-FIX-01 · scanner behaviour is unchanged', () => {
  it('12 · decoding, the duplicate-scan guard and onCode are untouched', () => {
    expect(CODE).toContain('decodeFromVideoDevice')
    expect(CODE).toContain('now - lastScanRef.current.ts < 2000')
    expect(CODE).toContain('onCode(code)')
  })

  it('13 · camera selection and torch still work off the live stream', () => {
    expect(CODE).toContain('listVideoInputDevices()')
    expect(CODE).toContain('applyConstraints')
    expect(CODE).toContain('caps?.torch')
  })

  it('14 · the component remains the only camera owner — no manager was added', () => {
    expect(CODE).not.toMatch(/navigator\.mediaDevices\.getUserMedia/)
    expect(CODE).not.toMatch(/window\.__|globalThis\./)
  })
})
