// Does a certificate layout actually have somewhere to PUT an attendee photo?
//
// Asked in three places that must agree: the renderer (skip the storage read when the
// answer is no), the public Certificate Center (do not offer an upload that could never
// appear), and the tests. One predicate, so they cannot drift apart.
//
// Deliberately free of any Firebase import — this is pure, so a unit test can call it
// without booting the Admin SDK.

import type { CertificateLayout } from './types'

/** True when the layout contains at least one image element fed by the attendee photo. */
export function layoutHasAttendeePhoto(layout: CertificateLayout | null | undefined): boolean {
  return !!layout?.elements?.some(el => el.type === 'image' && el.source === 'attendeePhoto')
}
