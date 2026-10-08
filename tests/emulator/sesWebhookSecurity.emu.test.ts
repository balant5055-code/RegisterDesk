// RD-COMMS-P2-C — SES/SNS delivery webhook security, on REAL Firestore (emulator), with REAL RSA
// signature verification (a throwaway key + self-signed certificate generated at test time with
// openssl — no key is stored in the repository). The certificate "download" is the only thing
// stubbed: fetch is answered locally for the SNS certificate URL.
//
//   • only the configured SES topic is accepted; any other topic is refused before anything else;
//   • no configuration ⇒ fail closed (nothing accepted);
//   • a bad signature, a missing/unknown SignatureVersion, a non-https or non-AWS certificate URL ⇒ refused;
//   • a valid bounce/complaint still suppresses (platform-wide + the organizer's list, as before);
//   • a duplicate / replayed MessageId changes nothing again.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import crypto from 'crypto'
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const hasOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true } catch { return false } })()
const describeEmu = EMULATOR && hasOpenssl ? describe : describe.skip
const T = 120_000
const P = process.pid
const TOPIC = 'arn:aws:sns:ap-south-1:123456789012:ses-notifications'
const OTHER_TOPIC = 'arn:aws:sns:us-east-1:999999999999:attacker-topic'
const CERT_URL = 'https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-0123456789abcdef.pem'

describeEmu('RD-COMMS-P2-C · SES webhook security (real Firestore, real signatures)', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let POST: (req: NextRequest) => Promise<Response>
  let key = '', cert = ''
  let certFetches = 0
  const realFetch = globalThis.fetch
  const savedTopics = process.env.SES_SNS_TOPIC_ARNS
  const emails: string[] = []
  const msgIds: string[] = []
  let n = 0

  const SIGNABLE: Record<string, string[]> = {
    Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
    SubscriptionConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
  }
  function sign(msg: Record<string, string>, version = '1'): Record<string, string> {
    let canonical = ''
    for (const k of SIGNABLE[msg.Type]) if (msg[k] !== undefined) canonical += `${k}\n${msg[k]}\n`
    const sig = crypto.createSign(version === '2' ? 'RSA-SHA256' : 'RSA-SHA1').update(canonical, 'utf8').sign(key, 'base64')
    return { ...msg, SignatureVersion: version, Signature: sig, SigningCertURL: CERT_URL }
  }
  function complaint(email: string, over: Record<string, string> = {}) {
    const MessageId = `p2c-${P}-${++n}-${crypto.randomUUID()}`
    msgIds.push(MessageId)
    return {
      Type: 'Notification', MessageId, TopicArn: TOPIC, Timestamp: new Date().toISOString(),
      Message: JSON.stringify({ notificationType: 'Complaint', mail: { messageId: `ses-${n}` }, complaint: { complainedRecipients: [{ emailAddress: email }], complaintFeedbackType: 'abuse' } }),
      ...over,
    }
  }
  const post = (body: unknown) => POST(new NextRequest('http://localhost/api/webhooks/ses', { method: 'POST', body: JSON.stringify(body) }))
  const victim = () => { const e = `p2c-victim-${P}-${++n}@example.test`; emails.push(e); return e }
  const suppressed = async (email: string) => (await adminDb.doc(`emailSuppressionList/__platform___${email.toLowerCase()}`).get()).exists

  beforeAll(async () => {
    if (!(process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')) throw new Error('demo project only')
    const dir = mkdtempSync(join(tmpdir(), 'p2c-sns-'))
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=sns.test.invalid'], { stdio: 'ignore', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
    key = readFileSync(join(dir, 'k.pem'), 'utf8'); cert = readFileSync(join(dir, 'c.pem'), 'utf8')
    rmSync(dir, { recursive: true, force: true })
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ POST } = await import('@/app/api/webhooks/ses/route') as unknown as { POST: typeof POST })
  }, T)
  beforeEach(() => {
    process.env.SES_SNS_TOPIC_ARNS = TOPIC
    certFetches = 0
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url === CERT_URL) { certFetches++; return new Response(cert, { status: 200 }) }
      return new Response('', { status: 200 })
    }) as typeof fetch
  })
  afterEach(() => { globalThis.fetch = realFetch })
  afterAll(async () => {
    process.env.SES_SNS_TOPIC_ARNS = savedTopics
    for (const e of emails) await adminDb.doc(`emailSuppressionList/__platform___${e.toLowerCase()}`).delete().catch(() => null)
    for (const id of msgIds) await adminDb.doc(`sesWebhookMessages/${id}`).delete().catch(() => null)
  }, T)

  it('a valid, signed complaint from the configured topic is accepted and suppresses the address (v1 and v2 signatures)', async () => {
    const a = victim(), b = victim()
    expect((await post(sign(complaint(a), '1'))).status).toBe(200)
    expect((await post(sign(complaint(b), '2'))).status).toBe(200)
    expect(await suppressed(a)).toBe(true)
    expect(await suppressed(b)).toBe(true)
  }, T)

  it('an UNEXPECTED topic is refused (403) — before any certificate is fetched, and nothing is suppressed', async () => {
    const v = victim()
    const res = await post(sign(complaint(v, { TopicArn: OTHER_TOPIC })))
    expect(res.status).toBe(403)
    expect(certFetches).toBe(0)
    expect(await suppressed(v)).toBe(false)
  }, T)

  it('no topic configured ⇒ fail closed (503), even for an otherwise valid message', async () => {
    process.env.SES_SNS_TOPIC_ARNS = ''
    const v = victim()
    expect((await post(sign(complaint(v)))).status).toBe(503)
    process.env.SES_SNS_TOPIC_ARNS = 'not-an-arn'
    expect((await post(sign(complaint(v)))).status).toBe(503)
    expect(await suppressed(v)).toBe(false)
  }, T)

  it('an invalid signature is refused (401)', async () => {
    const v = victim()
    const msg = sign(complaint(v))
    expect((await post({ ...msg, Message: msg.Message.replace('abuse', 'fraud') })).status).toBe(401)
    expect(await suppressed(v)).toBe(false)
  }, T)

  it('a missing or unknown SignatureVersion is refused — no SHA1 default', async () => {
    const v = victim()
    const { SignatureVersion: _drop, ...noVersion } = sign(complaint(v))
    void _drop
    expect((await post(noVersion)).status).toBe(401)
    expect((await post({ ...sign(complaint(v)), SignatureVersion: '3' })).status).toBe(401)
    expect(await suppressed(v)).toBe(false)
  }, T)

  it('a non-https, non-AWS or non-certificate-path SigningCertURL is refused and never fetched', async () => {
    const v = victim()
    for (const bad of [
      'http://sns.ap-south-1.amazonaws.com/SimpleNotificationService-0123456789abcdef.pem',
      'https://sns.ap-south-1.amazonaws.com.evil.test/SimpleNotificationService-0123456789abcdef.pem',
      'https://sns.ap-south-1.amazonaws.com/other/cert.pem',
      'https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-0123456789abcdef.pem?x=1',
    ]) {
      expect((await post({ ...sign(complaint(v)), SigningCertURL: bad })).status, bad).toBe(401)
    }
    expect(certFetches).toBe(0)
    expect(await suppressed(v)).toBe(false)
  }, T)

  it('a duplicate / replayed MessageId changes nothing again (an admin-cleared suppression stays cleared)', async () => {
    const v = victim()
    const msg = sign(complaint(v))
    expect((await post(msg)).status).toBe(200)
    expect(await suppressed(v)).toBe(true)
    await adminDb.doc(`emailSuppressionList/__platform___${v.toLowerCase()}`).delete()   // an admin clears it
    const again = await post(msg)
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ duplicate: true })
    expect(await suppressed(v)).toBe(false)
  }, T)

  it('a SubscriptionConfirmation from the configured topic is confirmed only via an AWS SNS https URL', async () => {
    const MessageId = `p2c-sub-${P}`
    const base = { Type: 'SubscriptionConfirmation', MessageId, TopicArn: TOPIC, Timestamp: new Date().toISOString(), Token: 't', Message: 'confirm' }
    expect((await post(sign({ ...base, SubscribeURL: 'https://evil.test/confirm' }))).status).toBe(400)
    expect((await post(sign({ ...base, SubscribeURL: 'https://sns.ap-south-1.amazonaws.com/?Action=ConfirmSubscription&Token=t' }))).status).toBe(200)
  }, T)
})
