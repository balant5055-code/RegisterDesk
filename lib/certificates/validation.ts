// Certificate settings validation — pure, SDK-free (client + server safe).
// Parses untrusted request bodies into strictly-typed settings values.

import {
  CERTIFICATE_TYPES,
  CERTIFICATE_TRIGGERS,
  TEMPLATE_TYPES,
  CERTIFICATE_JOB_SCOPE_LABELS,
  REVOCATION_REASONS,
  FONT_FAMILIES,
  MAX_LAYOUT_ELEMENTS,
  MAX_TEXT_CONTENT_LEN,
  CURRENT_LAYOUT_VERSION,
} from './constants'
import { validateAssignmentRules } from './assignment'
import type {
  CertificateType,
  CertificateTrigger,
  TemplateType,
  CertificateSettings,
  CertificateSettingsInput,
  CertificateSettingsPatch,
  CertificateJobScope,
  RevocationReason,
  FontFamily,
  CertificateLayout,
  LayoutElement,
} from './types'

// ─── Result type ──────────────────────────────────────────────────────────────

export type ValidationResult<T> =
  | { ok: true;  value: T }
  | { ok: false; error: string }

// Field limits — guard against abuse / oversized writes.
export const LIMITS = {
  emailSubjectMax:  200,
  emailMessageMax:  5000,
  templateIdMax:    200,
  templateNameMax:  120,
  fileNameMax:      255,
  fileUrlMax:       2000,
} as const

// ─── Primitive guards ───────────────────────────────────────────────────────

export function isCertificateType(v: unknown): v is CertificateType {
  return typeof v === 'string' && (CERTIFICATE_TYPES as string[]).includes(v)
}

export function isCertificateTrigger(v: unknown): v is CertificateTrigger {
  return typeof v === 'string' && (CERTIFICATE_TRIGGERS as string[]).includes(v)
}

export function isTemplateType(v: unknown): v is TemplateType {
  return typeof v === 'string' && (TEMPLATE_TYPES as string[]).includes(v)
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// ─── Nested group validators ──────────────────────────────────────────────────
// Each returns the validated group or an error string. They accept a partial
// flag: when `partial`, only the supplied keys are validated/returned.

type Verification = CertificateSettings['verification']
type AutoEmail    = CertificateSettings['autoEmail']
type Download     = CertificateSettings['download']

const VERIFICATION_BOOLS: (keyof Verification)[] = [
  'enabled', 'showParticipantName', 'showEventName', 'showIssueDate', 'showCertificateType',
]

function validateVerification(
  raw: unknown, partial: boolean,
): ValidationResult<Partial<Verification>> {
  if (!isObject(raw)) return { ok: false, error: 'verification must be an object' }
  const out: Partial<Verification> = {}
  for (const key of VERIFICATION_BOOLS) {
    if (key in raw) {
      if (typeof raw[key] !== 'boolean') return { ok: false, error: `verification.${key} must be a boolean` }
      out[key] = raw[key] as boolean
    } else if (!partial) {
      return { ok: false, error: `verification.${key} is required` }
    }
  }
  return { ok: true, value: out }
}

function validateAutoEmail(
  raw: unknown, partial: boolean,
): ValidationResult<Partial<AutoEmail>> {
  if (!isObject(raw)) return { ok: false, error: 'autoEmail must be an object' }
  const out: Partial<AutoEmail> = {}

  if ('enabled' in raw) {
    if (typeof raw.enabled !== 'boolean') return { ok: false, error: 'autoEmail.enabled must be a boolean' }
    out.enabled = raw.enabled
  } else if (!partial) {
    return { ok: false, error: 'autoEmail.enabled is required' }
  }

  if ('subject' in raw) {
    if (typeof raw.subject !== 'string') return { ok: false, error: 'autoEmail.subject must be a string' }
    if (raw.subject.length > LIMITS.emailSubjectMax) return { ok: false, error: `autoEmail.subject exceeds ${LIMITS.emailSubjectMax} chars` }
    out.subject = raw.subject
  } else if (!partial) {
    return { ok: false, error: 'autoEmail.subject is required' }
  }

  if ('message' in raw) {
    if (typeof raw.message !== 'string') return { ok: false, error: 'autoEmail.message must be a string' }
    if (raw.message.length > LIMITS.emailMessageMax) return { ok: false, error: `autoEmail.message exceeds ${LIMITS.emailMessageMax} chars` }
    out.message = raw.message
  } else if (!partial) {
    return { ok: false, error: 'autoEmail.message is required' }
  }

  return { ok: true, value: out }
}

const DOWNLOAD_BOOLS: (keyof Download)[] = ['enabled', 'requireVerification', 'allowAttendee']

function validateDownload(
  raw: unknown, partial: boolean,
): ValidationResult<Partial<Download>> {
  if (!isObject(raw)) return { ok: false, error: 'download must be an object' }
  const out: Partial<Download> = {}
  for (const key of DOWNLOAD_BOOLS) {
    if (key in raw) {
      if (typeof raw[key] !== 'boolean') return { ok: false, error: `download.${key} must be a boolean` }
      out[key] = raw[key] as boolean
    } else if (!partial) {
      return { ok: false, error: `download.${key} is required` }
    }
  }
  return { ok: true, value: out }
}

function validateActiveTemplateId(raw: unknown): ValidationResult<string | null> {
  if (raw === null) return { ok: true, value: null }
  if (typeof raw !== 'string') return { ok: false, error: 'activeTemplateId must be a string or null' }
  if (raw.length > LIMITS.templateIdMax) return { ok: false, error: 'activeTemplateId is too long' }
  return { ok: true, value: raw }
}

// ─── Full settings (PUT) ──────────────────────────────────────────────────────

/** Validates a complete settings body into a `CertificateSettingsInput`. */
export function validateSettingsInput(raw: unknown): ValidationResult<CertificateSettingsInput> {
  if (!isObject(raw)) return { ok: false, error: 'Request body must be an object' }

  if (typeof raw.enabled !== 'boolean') return { ok: false, error: 'enabled must be a boolean' }
  if (!isCertificateType(raw.defaultType)) return { ok: false, error: 'defaultType is invalid' }
  if (!isCertificateTrigger(raw.trigger)) return { ok: false, error: 'trigger is invalid' }

  const activeTemplateId = validateActiveTemplateId(raw.activeTemplateId)
  if (!activeTemplateId.ok) return activeTemplateId

  const verification = validateVerification(raw.verification, false)
  if (!verification.ok) return verification

  const autoEmail = validateAutoEmail(raw.autoEmail, false)
  if (!autoEmail.ok) return autoEmail

  const download = validateDownload(raw.download, false)
  if (!download.ok) return download

  // Programs (GA-6 S3) — optional passthrough so a full PUT round-trips the rules.
  let assignmentRules: import('./assignment').AssignmentRule[] | undefined
  if ('assignmentRules' in raw) {
    const r = validateAssignmentRules(raw.assignmentRules)
    if (!r.ok) return { ok: false, error: r.error }
    assignmentRules = r.rules
  }

  return {
    ok: true,
    value: {
      enabled:          raw.enabled,
      defaultType:      raw.defaultType,
      trigger:          raw.trigger,
      activeTemplateId: activeTemplateId.value,
      verification:     verification.value as Verification,
      autoEmail:        autoEmail.value as AutoEmail,
      download:         download.value as Download,
      ...(assignmentRules !== undefined ? { assignmentRules } : {}),
    },
  }
}

// ─── Partial settings (PATCH) ──────────────────────────────────────────────────

/** Validates a partial settings body into a `CertificateSettingsPatch`. */
export function validateSettingsPatch(raw: unknown): ValidationResult<CertificateSettingsPatch> {
  if (!isObject(raw)) return { ok: false, error: 'Request body must be an object' }

  const patch: CertificateSettingsPatch = {}

  if ('enabled' in raw) {
    if (typeof raw.enabled !== 'boolean') return { ok: false, error: 'enabled must be a boolean' }
    patch.enabled = raw.enabled
  }
  if ('defaultType' in raw) {
    if (!isCertificateType(raw.defaultType)) return { ok: false, error: 'defaultType is invalid' }
    patch.defaultType = raw.defaultType
  }
  if ('trigger' in raw) {
    if (!isCertificateTrigger(raw.trigger)) return { ok: false, error: 'trigger is invalid' }
    patch.trigger = raw.trigger
  }
  if ('activeTemplateId' in raw) {
    const r = validateActiveTemplateId(raw.activeTemplateId)
    if (!r.ok) return r
    patch.activeTemplateId = r.value
  }
  if ('verification' in raw) {
    const r = validateVerification(raw.verification, true)
    if (!r.ok) return r
    patch.verification = r.value
  }
  if ('autoEmail' in raw) {
    const r = validateAutoEmail(raw.autoEmail, true)
    if (!r.ok) return r
    patch.autoEmail = r.value
  }
  if ('download' in raw) {
    const r = validateDownload(raw.download, true)
    if (!r.ok) return r
    patch.download = r.value
  }
  if ('assignmentRules' in raw) {
    const r = validateAssignmentRules(raw.assignmentRules)   // GA-6 S3 — certificate programs
    if (!r.ok) return { ok: false, error: r.error }
    patch.assignmentRules = r.rules
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: 'No valid fields to update' }
  }
  return { ok: true, value: patch }
}

// ─── Bulk jobs (Phase 7) ────────────────────────────────────────────────────────

const JOB_SCOPES = Object.keys(CERTIFICATE_JOB_SCOPE_LABELS) as CertificateJobScope[]

export function isJobScope(v: unknown): v is CertificateJobScope {
  return typeof v === 'string' && (JOB_SCOPES as string[]).includes(v)
}

/** Caller-supplied fields when enqueuing a bulk generation job. */
export interface JobCreateInput {
  scope:            CertificateJobScope
  certificateType?: CertificateType        // omitted → resolved server-side
  registrationIds:  string[] | null        // required for single/selected
  autoEmail:        boolean
}

// Cap explicit id lists to a sane size to bound payloads.
const MAX_EXPLICIT_IDS = 5000

export function validateJobCreate(raw: unknown): ValidationResult<JobCreateInput> {
  if (!isObject(raw)) return { ok: false, error: 'Request body must be an object' }

  if (!isJobScope(raw.scope)) return { ok: false, error: 'scope must be single, selected, checked_in, or all' }
  const scope = raw.scope

  let certificateType: CertificateType | undefined
  if ('certificateType' in raw && raw.certificateType !== undefined && raw.certificateType !== null) {
    if (!isCertificateType(raw.certificateType)) return { ok: false, error: 'certificateType is invalid' }
    certificateType = raw.certificateType
  }

  let registrationIds: string[] | null = null
  if (scope === 'single' || scope === 'selected') {
    const ids = raw.registrationIds
    if (!Array.isArray(ids) || ids.length === 0) {
      return { ok: false, error: `registrationIds is required for the "${scope}" scope` }
    }
    if (!ids.every(id => typeof id === 'string' && id.length > 0)) {
      return { ok: false, error: 'registrationIds must be non-empty strings' }
    }
    if (scope === 'single' && ids.length !== 1) {
      return { ok: false, error: 'the "single" scope requires exactly one registrationId' }
    }
    if (ids.length > MAX_EXPLICIT_IDS) {
      return { ok: false, error: `registrationIds exceeds ${MAX_EXPLICIT_IDS} entries` }
    }
    // De-duplicate while preserving order.
    registrationIds = [...new Set(ids as string[])]
  }

  const autoEmail = raw.autoEmail === true

  return { ok: true, value: { scope, certificateType, registrationIds, autoEmail } }
}

// ─── Revocation (Phase 9) ───────────────────────────────────────────────────────

const REVOKE_CUSTOM_REASON_MAX = 500

export function isRevocationReason(v: unknown): v is RevocationReason {
  return typeof v === 'string' && (REVOCATION_REASONS as string[]).includes(v)
}

export interface RevokeInput {
  reason:        RevocationReason
  customReason?: string
}

export function validateRevoke(raw: unknown): ValidationResult<RevokeInput> {
  if (!isObject(raw)) return { ok: false, error: 'Request body must be an object' }
  if (!isRevocationReason(raw.reason)) return { ok: false, error: 'reason is invalid' }

  let customReason: string | undefined
  if ('customReason' in raw && raw.customReason !== undefined && raw.customReason !== null) {
    if (typeof raw.customReason !== 'string') return { ok: false, error: 'customReason must be a string' }
    const trimmed = raw.customReason.trim()
    if (trimmed.length > REVOKE_CUSTOM_REASON_MAX) {
      return { ok: false, error: `customReason exceeds ${REVOKE_CUSTOM_REASON_MAX} chars` }
    }
    if (trimmed) customReason = trimmed
  }

  if (raw.reason === 'other' && !customReason) {
    return { ok: false, error: 'customReason is required when reason is "other"' }
  }

  return { ok: true, value: { reason: raw.reason, customReason } }
}

// ─── Layout / builder (Phase 10) ────────────────────────────────────────────────

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

function isFraction(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
}

function isFontFamily(v: unknown): v is FontFamily {
  return typeof v === 'string' && (FONT_FAMILIES as readonly string[]).includes(v)
}

// Validates the fields common to every element; mutates `out` with them.
function validateBase(raw: Record<string, unknown>, out: Record<string, unknown>): string | null {
  if (typeof raw.id !== 'string' || !raw.id) return 'element.id is required'
  if (typeof raw.zIndex !== 'number' || !Number.isFinite(raw.zIndex)) return 'element.zIndex must be a number'
  if (!isFraction(raw.x) || !isFraction(raw.y)) return 'element.x/y must be in [0,1]'
  out.id = raw.id; out.zIndex = raw.zIndex; out.x = raw.x; out.y = raw.y

  for (const k of ['width', 'height', 'opacity'] as const) {
    if (k in raw && raw[k] !== undefined) {
      if (!isFraction(raw[k])) return `element.${k} must be in [0,1]`
      out[k] = raw[k]
    }
  }
  if ('rotation' in raw && raw.rotation !== undefined) {
    if (typeof raw.rotation !== 'number' || !Number.isFinite(raw.rotation)) return 'element.rotation must be a number'
    out.rotation = raw.rotation
  }
  return null
}

function validateElement(raw: unknown): ValidationResult<LayoutElement> {
  if (!isObject(raw)) return { ok: false, error: 'element must be an object' }
  const out: Record<string, unknown> = { type: raw.type }
  const baseErr = validateBase(raw, out)
  if (baseErr) return { ok: false, error: baseErr }

  switch (raw.type) {
    case 'text': {
      if (typeof raw.content !== 'string') return { ok: false, error: 'text.content must be a string' }
      if (raw.content.length > MAX_TEXT_CONTENT_LEN) return { ok: false, error: 'text.content is too long' }
      if (!isFontFamily(raw.fontFamily)) return { ok: false, error: 'text.fontFamily is invalid' }
      if (typeof raw.fontSizeFrac !== 'number' || !(raw.fontSizeFrac > 0 && raw.fontSizeFrac <= 1)) {
        return { ok: false, error: 'text.fontSizeFrac must be in (0,1]' }
      }
      if (raw.weight !== 'normal' && raw.weight !== 'bold') return { ok: false, error: 'text.weight must be normal or bold' }
      if (typeof raw.color !== 'string' || !HEX_COLOR.test(raw.color)) return { ok: false, error: 'text.color must be #RRGGBB' }
      if (raw.align !== 'left' && raw.align !== 'center' && raw.align !== 'right') {
        return { ok: false, error: 'text.align must be left, center, or right' }
      }
      out.content = raw.content; out.fontFamily = raw.fontFamily; out.fontSizeFrac = raw.fontSizeFrac
      out.weight = raw.weight; out.color = raw.color; out.align = raw.align
      if (raw.italic !== undefined) {
        if (typeof raw.italic !== 'boolean') return { ok: false, error: 'text.italic must be a boolean' }
        out.italic = raw.italic
      }
      return { ok: true, value: out as unknown as LayoutElement }
    }
    case 'image': {
      if (typeof raw.assetUrl !== 'string' || !/^https:\/\//.test(raw.assetUrl)) {
        return { ok: false, error: 'image.assetUrl must be an https URL' }
      }
      if (raw.assetUrl.length > LIMITS.fileUrlMax) return { ok: false, error: 'image.assetUrl is too long' }
      if (raw.fit !== 'contain' && raw.fit !== 'cover') return { ok: false, error: 'image.fit must be contain or cover' }
      out.assetUrl = raw.assetUrl; out.fit = raw.fit
      if (raw.role !== undefined) {
        if (raw.role !== 'image' && raw.role !== 'logo' && raw.role !== 'signature' && raw.role !== 'seal') {
          return { ok: false, error: 'image.role must be image, logo, signature, or seal' }
        }
        out.role = raw.role
      }
      return { ok: true, value: out as unknown as LayoutElement }
    }
    case 'qr': {
      if (raw.source !== 'verify') return { ok: false, error: 'qr.source must be "verify"' }
      out.source = 'verify'
      if (raw.darkColor !== undefined) {
        if (typeof raw.darkColor !== 'string' || !HEX_COLOR.test(raw.darkColor)) return { ok: false, error: 'qr.darkColor must be #RRGGBB' }
        out.darkColor = raw.darkColor
      }
      return { ok: true, value: out as unknown as LayoutElement }
    }
    case 'line': {
      if (typeof raw.color !== 'string' || !HEX_COLOR.test(raw.color)) return { ok: false, error: 'line.color must be #RRGGBB' }
      if (!isFraction(raw.thickness) || raw.thickness === 0) return { ok: false, error: 'line.thickness must be in (0,1]' }
      out.color = raw.color; out.thickness = raw.thickness
      return { ok: true, value: out as unknown as LayoutElement }
    }
    default:
      return { ok: false, error: `unknown element type "${String(raw.type)}"` }
  }
}

export function validateLayout(raw: unknown): ValidationResult<CertificateLayout> {
  if (!isObject(raw)) return { ok: false, error: 'Request body must be an object' }

  const canvas = raw.canvas
  if (!isObject(canvas)) return { ok: false, error: 'canvas is required' }
  if (typeof canvas.width !== 'number' || canvas.width <= 0 ||
      typeof canvas.height !== 'number' || canvas.height <= 0) {
    return { ok: false, error: 'canvas.width/height must be positive numbers' }
  }
  if (canvas.unit !== 'pt' && canvas.unit !== 'px') return { ok: false, error: 'canvas.unit must be pt or px' }

  if (!Array.isArray(raw.elements)) return { ok: false, error: 'elements must be an array' }
  if (raw.elements.length > MAX_LAYOUT_ELEMENTS) {
    return { ok: false, error: `elements exceeds ${MAX_LAYOUT_ELEMENTS}` }
  }

  const elements: LayoutElement[] = []
  for (let i = 0; i < raw.elements.length; i++) {
    const r = validateElement(raw.elements[i])
    if (!r.ok) return { ok: false, error: `elements[${i}]: ${r.error}` }
    elements.push(r.value)
  }

  const version = typeof raw.version === 'number' ? raw.version : CURRENT_LAYOUT_VERSION

  return {
    ok: true,
    value: {
      version,
      canvas: { width: canvas.width, height: canvas.height, unit: canvas.unit },
      elements,
    },
  }
}

// ─── Template management (Phase 4) ──────────────────────────────────────────────

/** Caller-supplied fields when registering an uploaded template. */
export interface TemplateCreateInput {
  name:         string
  templateType: TemplateType
  fileUrl:      string
  fileName:     string
}

export function validateTemplateCreate(raw: unknown): ValidationResult<TemplateCreateInput> {
  if (!isObject(raw)) return { ok: false, error: 'Request body must be an object' }

  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name) return { ok: false, error: 'name is required' }
  if (name.length > LIMITS.templateNameMax) return { ok: false, error: `name exceeds ${LIMITS.templateNameMax} chars` }

  if (!isTemplateType(raw.templateType)) return { ok: false, error: 'templateType must be pdf, png, or jpg' }

  if (typeof raw.fileUrl !== 'string' || !raw.fileUrl) return { ok: false, error: 'fileUrl is required' }
  if (raw.fileUrl.length > LIMITS.fileUrlMax) return { ok: false, error: 'fileUrl is too long' }
  if (!/^https:\/\//.test(raw.fileUrl)) return { ok: false, error: 'fileUrl must be an https URL' }

  const fileName = typeof raw.fileName === 'string' ? raw.fileName.trim() : ''
  if (!fileName) return { ok: false, error: 'fileName is required' }
  if (fileName.length > LIMITS.fileNameMax) return { ok: false, error: 'fileName is too long' }

  return { ok: true, value: { name, templateType: raw.templateType, fileUrl: raw.fileUrl, fileName } }
}

/** Partial update to a template: rename and/or (de)activate. */
export interface TemplatePatchInput {
  name?:     string
  isActive?: boolean
}

export function validateTemplatePatch(raw: unknown): ValidationResult<TemplatePatchInput> {
  if (!isObject(raw)) return { ok: false, error: 'Request body must be an object' }

  const patch: TemplatePatchInput = {}

  if ('name' in raw) {
    if (typeof raw.name !== 'string') return { ok: false, error: 'name must be a string' }
    const name = raw.name.trim()
    if (!name) return { ok: false, error: 'name cannot be empty' }
    if (name.length > LIMITS.templateNameMax) return { ok: false, error: `name exceeds ${LIMITS.templateNameMax} chars` }
    patch.name = name
  }

  if ('isActive' in raw) {
    if (typeof raw.isActive !== 'boolean') return { ok: false, error: 'isActive must be a boolean' }
    patch.isActive = raw.isActive
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: 'No valid fields to update' }
  }
  return { ok: true, value: patch }
}
