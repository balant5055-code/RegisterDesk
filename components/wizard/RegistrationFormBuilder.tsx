'use client'

import { useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertTriangle,
  AlignLeft,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Copy,
  Eye,
  FileText,
  FolderOpen,
  GripVertical,
  Info,
  Layers,
  ListChecks,
  Pencil,
  Plus,
  Settings2,
  Ticket,
  Trash2,
  X,
  Zap,
} from 'lucide-react'
import { buttonVariants } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import {
  BLANK_FORM_SETTINGS,
  BLANK_REGISTRATION_RULES,
  BLANK_TEAM_SETTINGS,
  FIELD_TYPES,
  applyPassGroups,
  applyPassGroupsToSections,
  deriveFields,
  getFormTemplates,
  makeBlankField,
  makeFieldId,
  makeRuleId,
  makeSectionId,
  migrateFieldsToSections,
  type ConditionalRule,
  type FieldType,
  type FormField,
  type FormSection,
  type FormSettings,
  type FormTemplateConfig,
  type RegistrationFormDraft,
  type RegistrationRules,
  type TeamSettings,
} from '@/components/wizard/registrationFormConfig'

/** Minimal pass descriptor threaded into the form builder from Step 4. */
export interface PassSummary {
  id:   string
  name: string
}

// ─── Shared primitives (matching the existing RegisterDesk design tokens) ──────

const EASE = [0.22, 1, 0.36, 1] as const

const inputCls =
  'h-9 w-full rounded-lg border border-border bg-background px-3 text-[12.5px] text-foreground placeholder:text-muted-foreground/60 outline-none transition-colors focus:border-primary/50 focus:ring-2 focus:ring-primary/20'

const labelCls = 'mb-1 block text-[12px] font-medium text-foreground'
const hintCls  = 'mt-1 text-[11px] text-muted-foreground'

type Tab = 'template' | 'fields' | 'settings' | 'logic'

const TABS: { id: Tab; label: string; icon: typeof AlignLeft }[] = [
  { id: 'template', label: 'Template',          icon: FileText   },
  { id: 'fields',   label: 'Sections & Fields', icon: Layers     },
  { id: 'settings', label: 'Settings & Rules',  icon: Settings2  },
  { id: 'logic',    label: 'Conditional Logic', icon: Zap        },
]

// ─── Primitive components ──────────────────────────────────────────────────────

function SectionCard({ title, children, action }: { title?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between">
          {title && <p className="text-[13px] font-semibold text-foreground">{title}</p>}
          {action}
        </div>
      )}
      {children}
    </div>
  )
}

function Toggle({ checked, onChange, label, desc }: { checked: boolean; onChange: (v: boolean) => void; label: string; desc?: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[12.5px] font-medium text-foreground">{label}</p>
        {desc && <p className="text-[11.5px] leading-snug text-muted-foreground">{desc}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-[22px] w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200',
          checked ? 'bg-primary' : 'bg-muted-foreground/30',
        )}
      >
        <span className={cn(
          'inline-block size-[18px] rounded-full bg-white shadow-sm transition-transform duration-200',
          checked ? 'translate-x-[18px]' : 'translate-x-0',
        )} />
      </button>
    </div>
  )
}

function FieldTypeBadge({ type }: { type: FieldType }) {
  const label = FIELD_TYPES.find(t => t.id === type)?.label ?? type
  return (
    <span className="rounded-full bg-muted/60 px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground">
      {label}
    </span>
  )
}

// ─── Conditional Logic Utilities ─────────────────────────────────────────────

const OPERATOR_LABELS: Record<ConditionalRule['operator'], string> = {
  equals:       'equals',
  not_equals:   'does not equal',
  contains:     'contains',
  not_contains: 'does not contain',
  greater_than: 'is greater than',
  less_than:    'is less than',
  is_empty:     'is empty',
  is_not_empty: 'is not empty',
}

const ACTION_LABELS: Record<ConditionalRule['action'], string> = {
  show:         'Show',
  hide:         'Hide',
  require:      'Make Required',
  make_optional:'Make Optional',
  enable:       'Enable',
  disable:      'Disable',
}

/** Returns true when the rule's condition holds for the given field values. */
function evaluateRule(
  rule:   ConditionalRule,
  values: Record<string, string>,
): boolean {
  if (!rule.enabled) return false
  const v  = (values[rule.sourceFieldId] ?? '').toString()
  const rv = rule.value
  switch (rule.operator) {
    case 'equals':       return v.toLowerCase() === rv.toLowerCase()
    case 'not_equals':   return v.toLowerCase() !== rv.toLowerCase()
    case 'contains':     return v.toLowerCase().includes(rv.toLowerCase())
    case 'not_contains': return !v.toLowerCase().includes(rv.toLowerCase())
    case 'greater_than': return Number(v) > Number(rv)
    case 'less_than':    return Number(v) < Number(rv)
    case 'is_empty':     return v.trim() === ''
    case 'is_not_empty': return v.trim() !== ''
    default:             return false
  }
}

/** Applies all enabled rules to a base field state and returns the computed state. */
function applyRules(
  fields: FormField[],
  rules:  ConditionalRule[],
  values: Record<string, string>,
): Map<string, { visible: boolean; required: boolean; disabled: boolean }> {
  const state = new Map<string, { visible: boolean; required: boolean; disabled: boolean }>(
    fields.map(f => [f.id, { visible: f.visible, required: f.required, disabled: false }]),
  )
  for (const rule of rules) {
    if (!evaluateRule(rule, values)) continue
    const s = state.get(rule.targetFieldId)
    if (!s) continue
    switch (rule.action) {
      case 'show':         s.visible   = true;  break
      case 'hide':         s.visible   = false; break
      case 'require':      s.required  = true;  break
      case 'make_optional':s.required  = false; break
      case 'enable':       s.disabled  = false; break
      case 'disable':      s.disabled  = true;  break
    }
  }
  return state
}

/** DFS check: would adding srcId→tgtId create a cycle in the rule graph? */
function hasCircularDependency(
  rules: ConditionalRule[],
  srcId: string,
  tgtId: string,
): boolean {
  const deps = new Map<string, string[]>()
  for (const r of rules) {
    if (!deps.has(r.sourceFieldId)) deps.set(r.sourceFieldId, [])
    deps.get(r.sourceFieldId)!.push(r.targetFieldId)
  }
  const visited = new Set<string>()
  const stack   = [tgtId]
  while (stack.length > 0) {
    const cur = stack.pop()!
    if (cur === srcId) return true
    if (visited.has(cur)) continue
    visited.add(cur)
    for (const dep of (deps.get(cur) ?? [])) stack.push(dep)
  }
  return false
}

// ─── Template Tab ─────────────────────────────────────────────────────────────

function TemplateTab({
  templates,
  selectedId,
  onApply,
}: {
  templates:  FormTemplateConfig[]
  selectedId: string
  onApply:    (t: FormTemplateConfig) => void
}) {
  if (templates.length === 0) {
    return (
      <SectionCard>
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <FileText className="size-8 text-muted-foreground/30" aria-hidden />
          <p className="text-[12.5px] font-semibold text-foreground">No templates found</p>
          <p className="text-[12px] text-muted-foreground">Add fields manually in the Fields tab.</p>
        </div>
      </SectionCard>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2 rounded-lg border border-primary/10 bg-primary/[0.04] px-4 py-3">
        <Info className="mt-0.5 size-3.5 shrink-0 text-primary/70" aria-hidden />
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Select a template to auto-load default fields. You can add, edit, or remove fields afterwards.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {templates.map(t => {
          const isSelected = selectedId === t.id
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onApply(t)}
              className={cn(
                'flex flex-col items-start gap-1 rounded-xl border-[1.5px] p-4 text-left transition-all duration-150',
                isSelected
                  ? 'border-primary bg-primary/[0.03] shadow-sm'
                  : 'border-border bg-card hover:border-primary/30 hover:bg-muted/[0.03]',
              )}
            >
              <div className="flex w-full items-start justify-between gap-2">
                <div className={cn(
                  'flex size-7 shrink-0 items-center justify-center rounded-lg',
                  isSelected ? 'bg-primary/10' : 'bg-muted/40',
                )}>
                  <ClipboardList className={cn('size-3.5', isSelected ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
                </div>
                {isSelected && (
                  <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold text-primary-foreground">
                    Active
                  </span>
                )}
              </div>
              <p className={cn('mt-1.5 text-[12.5px] font-semibold', isSelected ? 'text-foreground' : 'text-foreground/80')}>
                {t.label}
              </p>
              <p className="text-[11.5px] leading-snug text-muted-foreground">{t.description}</p>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ─── Fields Tab (section-based) ───────────────────────────────────────────────

function FieldsTab({
  sections,
  onAddSection,
  onRenameSection,
  onDeleteSection,
  onDuplicateSection,
  onMoveSection,
  onAddField,
  onEditField,
  onDeleteField,
  onDuplicateField,
  onMoveField,
}: {
  sections:           FormSection[]
  onAddSection:       (title: string) => void
  onRenameSection:    (id: string, title: string) => void
  onDeleteSection:    (id: string) => void
  onDuplicateSection: (id: string) => void
  onMoveSection:      (id: string, dir: 'up' | 'down') => void
  onAddField:         (sectionId: string) => void
  onEditField:        (field: FormField, sectionId: string) => void
  onDeleteField:      (fieldId: string, sectionId: string) => void
  onDuplicateField:   (field: FormField, sectionId: string) => void
  onMoveField:        (fieldId: string, sectionId: string, dir: 'up' | 'down') => void
}) {
  const [showAddSection,       setShowAddSection]       = useState(false)
  const [newSectionTitle,      setNewSectionTitle]      = useState('')
  const [renamingId,           setRenamingId]           = useState<string | null>(null)
  const [renameValue,          setRenameValue]          = useState('')
  const [delSectionConfirmId,  setDelSectionConfirmId]  = useState<string | null>(null)
  const [delFieldConfirmKey,   setDelFieldConfirmKey]   = useState<string | null>(null)

  const handleAddSection = () => {
    const t = newSectionTitle.trim()
    if (!t) return
    onAddSection(t)
    setNewSectionTitle('')
    setShowAddSection(false)
  }

  const handleSaveRename = () => {
    if (renamingId && renameValue.trim()) onRenameSection(renamingId, renameValue.trim())
    setRenamingId(null)
  }

  const FieldRow = ({ field, sectionId, idx, total }: { field: FormField; sectionId: string; idx: number; total: number }) => {
    const delKey    = `${sectionId}:${field.id}`
    const isDel     = delFieldConfirmKey === delKey
    return (
      <div className={cn(
        'group grid grid-cols-[1fr_auto_auto_auto] items-center gap-2 border-b border-border/30 px-4 py-2 transition-colors last:border-0',
        isDel ? 'bg-red-50/60' : 'hover:bg-muted/[0.03]',
      )}>
        <div className="flex min-w-0 items-center gap-2">
          <GripVertical className="size-3 shrink-0 text-muted-foreground/25" aria-hidden />
          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
            <span className="truncate text-[12px] font-medium text-foreground">
              {field.label || <span className="italic text-muted-foreground/40">Untitled</span>}
            </span>
            <FieldTypeBadge type={field.type} />
            {field.section && field.section !== 'basic' && (
              <span className="rounded-full bg-violet-50 px-1.5 py-px text-[10px] font-medium text-violet-600">{field.section}</span>
            )}
            {Array.isArray(field.passVisibility) && field.passVisibility.length > 0 && (
              <span className="rounded-full bg-sky-50 px-1.5 py-px text-[10px] font-medium text-sky-600">
                {field.passVisibility.length} pass{field.passVisibility.length !== 1 ? 'es' : ''}
              </span>
            )}
            {Array.isArray(field.passVisibility) && field.passVisibility.length === 0 && (
              <span className="rounded-full bg-amber-50 px-1.5 py-px text-[10px] font-medium text-amber-600">no pass</span>
            )}
          </div>
        </div>

        <div className="flex w-[52px] justify-center">
          <span className={cn('rounded-full px-2 py-px text-[10.5px] font-semibold', field.required ? 'bg-rose-50 text-rose-600' : 'bg-muted text-muted-foreground')}>
            {field.required ? 'Req' : 'Opt'}
          </span>
        </div>
        <div className="flex w-[52px] justify-center">
          <span className={cn('rounded-full px-2 py-px text-[10.5px] font-semibold', field.visible ? 'bg-emerald-50 text-emerald-600' : 'bg-muted text-muted-foreground')}>
            {field.visible ? 'Show' : 'Hide'}
          </span>
        </div>

        <div className="flex w-[80px] items-center justify-end gap-0.5">
          {isDel ? (
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => { onDeleteField(field.id, sectionId); setDelFieldConfirmKey(null) }}
                className="rounded bg-red-500 px-2 py-0.5 text-[10.5px] font-semibold text-white hover:bg-red-600">Delete</button>
              <button type="button" onClick={() => setDelFieldConfirmKey(null)}
                className="rounded px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:bg-muted/50">✕</button>
            </div>
          ) : (
            <>
              <button type="button" disabled={idx === 0} onClick={() => onMoveField(field.id, sectionId, 'up')}
                className="flex size-6 items-center justify-center rounded text-muted-foreground/40 hover:bg-muted/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-20" aria-label="Move up">
                <ChevronUp className="size-3.5" aria-hidden />
              </button>
              <button type="button" disabled={idx === total - 1} onClick={() => onMoveField(field.id, sectionId, 'down')}
                className="flex size-6 items-center justify-center rounded text-muted-foreground/40 hover:bg-muted/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-20" aria-label="Move down">
                <ChevronDown className="size-3.5" aria-hidden />
              </button>
              <button type="button" onClick={() => onEditField(field, sectionId)}
                className="flex size-6 items-center justify-center rounded text-muted-foreground/40 hover:bg-primary/10 hover:text-primary" aria-label={`Edit ${field.label}`}>
                <Pencil className="size-3" aria-hidden />
              </button>
              <button type="button" onClick={() => onDuplicateField(field, sectionId)}
                className="flex size-6 items-center justify-center rounded text-muted-foreground/40 hover:bg-muted/60 hover:text-foreground" aria-label={`Duplicate ${field.label}`}>
                <Copy className="size-3" aria-hidden />
              </button>
              <button type="button" onClick={() => setDelFieldConfirmKey(delKey)}
                className="flex size-6 items-center justify-center rounded text-muted-foreground/40 hover:bg-red-50 hover:text-red-500" aria-label={`Delete ${field.label}`}>
                <Trash2 className="size-3" aria-hidden />
              </button>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {sections.length === 0 ? (
        <SectionCard>
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-muted/40">
              <Layers className="size-5 text-muted-foreground/40" aria-hidden />
            </div>
            <div>
              <p className="text-[13px] font-semibold text-foreground">No sections yet</p>
              <p className="mt-0.5 max-w-[240px] text-[12px] text-muted-foreground">
                Apply a template above or add a section manually using the button below.
              </p>
            </div>
          </div>
        </SectionCard>
      ) : (
        sections.map((section, sIdx) => {
          const isRenaming = renamingId === section.id
          const isDelSec   = delSectionConfirmId === section.id
          return (
            <div key={section.id} className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">

              {/* Section header */}
              <div className="flex items-center gap-2 border-b border-border/70 bg-muted/[0.04] px-4 py-2">
                <FolderOpen className="size-3.5 shrink-0 text-muted-foreground/50" aria-hidden />

                {isRenaming ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onBlur={handleSaveRename}
                    onKeyDown={e => { if (e.key === 'Enter') handleSaveRename(); if (e.key === 'Escape') setRenamingId(null) }}
                    maxLength={60}
                    className="h-7 flex-1 rounded border border-primary/50 bg-background px-2 text-[13px] font-semibold text-foreground outline-none focus:ring-2 focus:ring-primary/20"
                  />
                ) : (
                  <p className="flex-1 truncate text-[13px] font-semibold text-foreground">{section.title}</p>
                )}

                <span className="shrink-0 rounded-full bg-muted/60 px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground">
                  {section.fields.length} field{section.fields.length !== 1 ? 's' : ''}
                </span>

                {isDelSec ? (
                  <div className="flex items-center gap-1">
                    <button type="button" onClick={() => { onDeleteSection(section.id); setDelSectionConfirmId(null) }}
                      className="rounded bg-red-500 px-2 py-0.5 text-[10.5px] font-semibold text-white hover:bg-red-600">Delete</button>
                    <button type="button" onClick={() => setDelSectionConfirmId(null)}
                      className="rounded px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:bg-muted/50">✕</button>
                  </div>
                ) : (
                  <div className="flex items-center gap-0.5">
                    <button type="button" disabled={sIdx === 0} onClick={() => onMoveSection(section.id, 'up')}
                      className="flex size-6 items-center justify-center rounded text-muted-foreground/40 hover:bg-muted/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-20" aria-label="Move section up">
                      <ChevronUp className="size-3.5" aria-hidden />
                    </button>
                    <button type="button" disabled={sIdx === sections.length - 1} onClick={() => onMoveSection(section.id, 'down')}
                      className="flex size-6 items-center justify-center rounded text-muted-foreground/40 hover:bg-muted/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-20" aria-label="Move section down">
                      <ChevronDown className="size-3.5" aria-hidden />
                    </button>
                    <button type="button" onClick={() => { setRenamingId(section.id); setRenameValue(section.title) }}
                      className="flex size-6 items-center justify-center rounded text-muted-foreground/40 hover:bg-primary/10 hover:text-primary" aria-label="Rename section">
                      <Pencil className="size-3" aria-hidden />
                    </button>
                    <button type="button" onClick={() => onDuplicateSection(section.id)}
                      className="flex size-6 items-center justify-center rounded text-muted-foreground/40 hover:bg-muted/60 hover:text-foreground" aria-label="Duplicate section">
                      <Copy className="size-3" aria-hidden />
                    </button>
                    <button type="button" onClick={() => setDelSectionConfirmId(section.id)}
                      className="flex size-6 items-center justify-center rounded text-muted-foreground/40 hover:bg-red-50 hover:text-red-500" aria-label="Delete section">
                      <Trash2 className="size-3" aria-hidden />
                    </button>
                  </div>
                )}
              </div>

              {/* Field column headers (only if fields exist) */}
              {section.fields.length > 0 && (
                <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 border-b border-border/40 bg-muted/[0.02] px-4 py-1.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Field</p>
                  <p className="w-[52px] text-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Req</p>
                  <p className="w-[52px] text-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Vis</p>
                  <p className="w-[80px]" />
                </div>
              )}

              {/* Fields */}
              {section.fields.map((field, fIdx) => (
                <FieldRow
                  key={field.id}
                  field={field}
                  sectionId={section.id}
                  idx={fIdx}
                  total={section.fields.length}
                />
              ))}

              {/* Add field to this section */}
              <div className={cn('px-4 py-2', section.fields.length > 0 && 'border-t border-border/40')}>
                <button type="button" onClick={() => onAddField(section.id)}
                  className={cn(
                    buttonVariants({ variant: 'outline', size: 'sm' }),
                    'w-full gap-1.5 border-dashed border-primary/20 text-[12px] text-primary/70 hover:border-primary/40 hover:bg-primary/[0.02]',
                  )}>
                  <Plus className="size-3" aria-hidden />
                  Add Field to "{section.title}"
                </button>
              </div>
            </div>
          )
        })
      )}

      {/* Add Section */}
      {showAddSection ? (
        <div className="flex gap-2">
          <input
            autoFocus
            className="h-9 flex-1 rounded-lg border border-primary/50 bg-background px-3 text-[12.5px] text-foreground outline-none focus:ring-2 focus:ring-primary/20"
            placeholder="Section title, e.g. Medical Information…"
            value={newSectionTitle}
            onChange={e => setNewSectionTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleAddSection(); if (e.key === 'Escape') { setShowAddSection(false); setNewSectionTitle('') } }}
            maxLength={60}
          />
          <button type="button" onClick={handleAddSection} disabled={!newSectionTitle.trim()}
            className={cn(buttonVariants({ variant: 'primary', size: 'sm' }), 'shrink-0', !newSectionTitle.trim() && 'pointer-events-none opacity-50')}>
            Add
          </button>
          <button type="button" onClick={() => { setShowAddSection(false); setNewSectionTitle('') }}
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'shrink-0')}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setShowAddSection(true)}
          className={cn(buttonVariants({ variant: 'outline' }), 'w-full gap-2 border-dashed border-primary/30 text-primary hover:border-primary/60 hover:bg-primary/[0.03]')}>
          <Plus className="size-4" aria-hidden />
          Add Section
        </button>
      )}
    </div>
  )
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

// ─── Mode selection card (reused across SettingsTab sections) ─────────────────

function ModeCard({
  label,
  desc,
  selected,
  onClick,
}: {
  label:    string
  desc?:    string
  selected: boolean
  onClick:  () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'flex flex-col gap-1 rounded-xl border-[1.5px] px-3.5 py-3 text-left transition-all duration-150',
        selected
          ? 'border-primary bg-primary/[0.03] shadow-sm'
          : 'border-border bg-card hover:border-primary/30 hover:bg-muted/[0.03]',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className={cn('text-[12.5px] font-semibold', selected ? 'text-foreground' : 'text-foreground/80')}>
          {label}
        </p>
        <div className={cn(
          'flex size-[16px] shrink-0 items-center justify-center rounded-full border-2',
          selected ? 'border-primary bg-primary' : 'border-border',
        )}>
          {selected && <div className="size-[8px] rounded-full bg-white" />}
        </div>
      </div>
      {desc && <p className="text-[11.5px] leading-snug text-muted-foreground">{desc}</p>}
    </button>
  )
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

function SettingsTab({
  rules,
  onChange,
  syncedApprovalMode  = null,
  approvalModeSource  = 'override',
  onApprovalModeSourceChange,
}: {
  rules:                       RegistrationRules
  onChange:                    (r: RegistrationRules) => void
  syncedApprovalMode?:         'auto' | 'manual' | null
  approvalModeSource?:         'synced' | 'override'
  onApprovalModeSourceChange?: (src: 'synced' | 'override') => void
}) {
  const upd     = (p: Partial<RegistrationRules>) => onChange({ ...rules, ...p })
  const updTeam = (p: Partial<TeamSettings>)      =>
    upd({ teamSettings: { ...rules.teamSettings, ...p } })

  const isTeam     = rules.registrationMode !== 'individual'
  const isManual   = rules.approvalMode === 'manual'
  const isWaitlist = rules.waitlistEnabled
  const isRedirect = rules.afterRegistration === 'redirect_url'

  return (
    <div className="flex flex-col gap-3">

      {/* Info */}
      <div className="flex items-start gap-2.5 rounded-lg border border-primary/10 bg-primary/[0.04] px-4 py-3">
        <Info className="mt-0.5 size-3.5 shrink-0 text-primary/70" aria-hidden />
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Control who can register, how registrations are approved, and what happens after submission.
        </p>
      </div>

      {/* ── 1. Registration Mode ── */}
      <SectionCard title="Registration Mode">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {([
            { id: 'individual', label: 'Individual', desc: 'Each person registers independently' },
            { id: 'team',       label: 'Team Only',  desc: 'Groups register as a single team' },
            { id: 'both',       label: 'Both',       desc: 'Allow individual and team registration' },
          ] as const).map(opt => (
            <ModeCard key={opt.id} label={opt.label} desc={opt.desc}
              selected={rules.registrationMode === opt.id}
              onClick={() => upd({ registrationMode: opt.id })}
            />
          ))}
        </div>
      </SectionCard>

      {/* ── 2. Registration Limits ── */}
      <SectionCard title="Registration Limits">
        <div className="flex flex-col gap-4">
          <Toggle checked={rules.limitPerEmail} onChange={v => upd({ limitPerEmail: v })}
            label="Limit by Email" desc="One registration allowed per email address" />
          <Toggle checked={rules.limitPerMobile} onChange={v => upd({ limitPerMobile: v })}
            label="Limit by Mobile" desc="One registration allowed per mobile number" />

          <div>
            <label className={labelCls}>
              Maximum Registrations
              <span className={cn(hintCls.replace('mt-1 ', ''), 'ml-2 inline font-normal')}>
                (Optional — blank = unlimited)
              </span>
            </label>
            <input
              type="number" min={1} className={inputCls}
              placeholder="e.g. 500"
              value={rules.maxRegistrations ?? ''}
              onChange={e => upd({ maxRegistrations: e.target.value ? Number(e.target.value) : null })}
            />
          </div>

          <div>
            <p className={labelCls}>Duplicate Registration Handling</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {([
                { id: 'block', label: 'Block',     desc: 'Reject duplicate submissions' },
                { id: 'warn',  label: 'Warn Only', desc: 'Alert but allow the duplicate' },
                { id: 'allow', label: 'Allow All', desc: 'No duplicate checking' },
              ] as const).map(opt => (
                <ModeCard key={opt.id} label={opt.label} desc={opt.desc}
                  selected={rules.duplicatePolicy === opt.id}
                  onClick={() => upd({ duplicatePolicy: opt.id })}
                />
              ))}
            </div>
          </div>
        </div>
      </SectionCard>

      {/* ── 3. Approval Flow ── */}
      <SectionCard title="Approval Flow">
        <div className="flex flex-col gap-4">

          {/* Approval Mode Source — shown when Step 3 has set a confirmation mode */}
          {syncedApprovalMode != null && (
            <div className="rounded-lg border border-border/60 bg-muted/[0.03] p-3.5">
              <p className="mb-2.5 text-[12px] font-semibold text-foreground">Approval Mode Source</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <ModeCard
                  label="Use Access Control Settings"
                  desc={`Synced from Step 3 — ${syncedApprovalMode === 'manual' ? 'Manual Approval' : 'Auto Approve'}`}
                  selected={approvalModeSource === 'synced'}
                  onClick={() => onApprovalModeSourceChange?.('synced')}
                />
                <ModeCard
                  label="Override In This Form"
                  desc="Set a different approval mode for this registration form only"
                  selected={approvalModeSource === 'override'}
                  onClick={() => onApprovalModeSourceChange?.('override')}
                />
              </div>
              {approvalModeSource === 'synced' && (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Approval mode is locked to the Access Control setting from Step 3.
                </p>
              )}
            </div>
          )}

          {/* Mode cards — locked (pointer-events-none) when synced from Step 3 */}
          <div className={cn(
            'grid grid-cols-1 gap-2 sm:grid-cols-2',
            approvalModeSource === 'synced' && 'pointer-events-none opacity-50 select-none',
          )}>
            {([
              { id: 'auto',   label: 'Auto Approve',    desc: 'Confirmed immediately after submission' },
              { id: 'manual', label: 'Manual Approval', desc: 'Pending until reviewed and approved' },
            ] as const).map(opt => (
              <ModeCard key={opt.id} label={opt.label} desc={opt.desc}
                selected={rules.approvalMode === opt.id}
                onClick={() => upd({ approvalMode: opt.id })}
              />
            ))}
          </div>

          {isManual && (
            <div className="flex flex-col gap-3">
              <div>
                <label className={labelCls}>
                  Approval Message
                  <span className={cn(hintCls.replace('mt-1 ', ''), 'ml-2 inline font-normal')}>(Optional)</span>
                </label>
                <textarea
                  className={cn(inputCls, 'h-16 resize-none py-2')}
                  placeholder="Shown after approval — e.g. Your registration has been approved!"
                  value={rules.approvalMessage}
                  onChange={e => upd({ approvalMessage: e.target.value })}
                  maxLength={300}
                />
              </div>
              <div>
                <label className={labelCls}>
                  Pending Status Message
                  <span className={cn(hintCls.replace('mt-1 ', ''), 'ml-2 inline font-normal')}>(Optional)</span>
                </label>
                <textarea
                  className={cn(inputCls, 'h-16 resize-none py-2')}
                  placeholder="Shown while pending — e.g. Your registration is under review. We'll notify you within 48 hours."
                  value={rules.pendingMessage}
                  onChange={e => upd({ pendingMessage: e.target.value })}
                  maxLength={300}
                />
              </div>
            </div>
          )}

          {/* Status flow display */}
          <div className="rounded-lg border border-border/60 bg-muted/[0.03] px-4 py-3">
            <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
              Registration Status Flow
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              {[
                { s: 'Draft',            dim: false },
                { s: 'Pending Payment',  dim: false },
                ...(isManual ? [{ s: 'Pending Approval', dim: false }] : []),
                { s: 'Confirmed',        dim: false },
                { s: 'Checked In',       dim: false },
              ].map(({ s }, i, arr) => (
                <div key={s} className="flex items-center gap-1">
                  <span className={cn(
                    'rounded-full px-2 py-0.5 text-[10.5px] font-medium',
                    s === 'Confirmed' || s === 'Checked In'  ? 'bg-emerald-50 text-emerald-700'
                    : s === 'Pending Approval'                ? 'bg-amber-50 text-amber-700'
                    : 'bg-muted text-muted-foreground',
                  )}>
                    {s}
                  </span>
                  {i < arr.length - 1 && <span className="text-[10px] text-muted-foreground/40">→</span>}
                </div>
              ))}
            </div>
            <p className="mt-1.5 text-[10.5px] text-muted-foreground">
              Also: <span className="text-rose-500 font-medium">Rejected</span>
              {', '}
              <span className="font-medium text-muted-foreground">Cancelled</span>
            </p>
          </div>
        </div>
      </SectionCard>

      {/* ── 4. Waitlist ── */}
      <SectionCard title="Waitlist">
        <div className="flex flex-col gap-4">
          <Toggle checked={rules.waitlistEnabled} onChange={v => upd({ waitlistEnabled: v })}
            label="Enable Waitlist"
            desc="Accept registrations beyond capacity into a waitlist queue" />

          {isWaitlist && (
            <>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {([
                  { id: 'auto',   label: 'Auto Move',   desc: 'Automatically promote when a spot opens' },
                  { id: 'manual', label: 'Manual Move',  desc: 'You manually promote waitlisted attendees' },
                ] as const).map(opt => (
                  <ModeCard key={opt.id} label={opt.label} desc={opt.desc}
                    selected={rules.waitlistMode === opt.id}
                    onClick={() => upd({ waitlistMode: opt.id })}
                  />
                ))}
              </div>
              <div>
                <label className={labelCls}>
                  Waitlist Capacity
                  <span className={cn(hintCls.replace('mt-1 ', ''), 'ml-2 inline font-normal')}>(Optional — blank = unlimited)</span>
                </label>
                <input
                  type="number" min={1} className={inputCls}
                  placeholder="e.g. 50"
                  value={rules.waitlistCapacity ?? ''}
                  onChange={e => upd({ waitlistCapacity: e.target.value ? Number(e.target.value) : null })}
                />
              </div>
            </>
          )}
        </div>
      </SectionCard>

      {/* ── 5. Login & Identity ── */}
      <SectionCard title="Login & Identity">
        <div className="flex flex-col gap-4">
          <Toggle checked={rules.requireLogin} onChange={v => upd({ requireLogin: v })}
            label="Require Login Before Registration"
            desc="Attendees must be signed in to access the registration form" />
          <Toggle checked={rules.allowGuestRegistration} onChange={v => upd({ allowGuestRegistration: v })}
            label="Allow Guest Registration"
            desc="Attendees can register without creating an account" />
          <Toggle checked={rules.requireEmailVerification} onChange={v => upd({ requireEmailVerification: v })}
            label="Require Email Verification"
            desc="Email address must be verified before registration is confirmed" />
          <Toggle checked={rules.requireMobileVerification} onChange={v => upd({ requireMobileVerification: v })}
            label="Require Mobile Verification"
            desc="Mobile number must be verified via OTP before confirmation" />
        </div>
      </SectionCard>

      {/* ── 6. Team Registration (shown when team mode) ── */}
      {isTeam && (
        <SectionCard title="Team Registration Settings">
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Minimum Team Size</label>
                <input
                  type="number" min={1} className={inputCls} placeholder="e.g. 2"
                  value={rules.teamSettings.minTeamSize ?? ''}
                  onChange={e => updTeam({ minTeamSize: e.target.value ? Number(e.target.value) : null })}
                />
              </div>
              <div>
                <label className={labelCls}>Maximum Team Size</label>
                <input
                  type="number" min={1} className={inputCls} placeholder="e.g. 11"
                  value={rules.teamSettings.maxTeamSize ?? ''}
                  onChange={e => updTeam({ maxTeamSize: e.target.value ? Number(e.target.value) : null })}
                />
              </div>
            </div>
            <Toggle checked={rules.teamSettings.captainRequired} onChange={v => updTeam({ captainRequired: v })}
              label="Team Captain Required"
              desc="Require one team member to be designated as captain" />
            <Toggle checked={rules.teamSettings.teamNameRequired} onChange={v => updTeam({ teamNameRequired: v })}
              label="Team Name Required"
              desc="Teams must provide a name during registration" />
          </div>
        </SectionCard>
      )}

      {/* ── 7. After Registration ── */}
      <SectionCard title="After Registration">
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {([
              { id: 'success_page', label: 'Show Success Page', desc: 'Display a branded confirmation page' },
              { id: 'redirect_url', label: 'Redirect to URL',   desc: 'Send attendees to a custom URL' },
            ] as const).map(opt => (
              <ModeCard key={opt.id} label={opt.label} desc={opt.desc}
                selected={rules.afterRegistration === opt.id}
                onClick={() => upd({ afterRegistration: opt.id })}
              />
            ))}
          </div>

          {isRedirect && (
            <div>
              <label className={labelCls}>Redirect URL <span className="text-red-500">*</span></label>
              <input
                type="url" className={inputCls}
                placeholder="https://your-website.com/thank-you"
                value={rules.redirectUrl}
                onChange={e => upd({ redirectUrl: e.target.value })}
              />
            </div>
          )}

          <div>
            <label className={labelCls}>
              Success Message
              <span className={cn(hintCls.replace('mt-1 ', ''), 'ml-2 inline font-normal')}>(Optional)</span>
            </label>
            <textarea
              className={cn(inputCls, 'h-16 resize-none py-2')}
              placeholder="e.g. You're registered! Check your email for confirmation details."
              value={rules.successMessage}
              onChange={e => upd({ successMessage: e.target.value })}
              maxLength={300}
            />
          </div>

          <div>
            <label className={labelCls}>
              Confirmation Email Message
              <span className={cn(hintCls.replace('mt-1 ', ''), 'ml-2 inline font-normal')}>(Optional)</span>
            </label>
            <textarea
              className={cn(inputCls, 'h-16 resize-none py-2')}
              placeholder="e.g. Thank you for registering. Your registration is confirmed…"
              value={rules.confirmationMessage}
              onChange={e => upd({ confirmationMessage: e.target.value })}
              maxLength={500}
            />
          </div>
        </div>
      </SectionCard>

      {/* ── 8. Form Behaviour ── */}
      <SectionCard title="Form Behaviour">
        <Toggle checked={rules.allowFileUpload} onChange={v => upd({ allowFileUpload: v })}
          label="Allow File Uploads"
          desc="Enable File Upload type fields in this registration form" />
      </SectionCard>

    </div>
  )
}

// ─── Conditional Logic Tab ────────────────────────────────────────────────────

function LogicTab({
  fields,
  rules,
  onChange,
}: {
  fields:   FormField[]
  rules:    ConditionalRule[]
  onChange: (r: ConditionalRule[]) => void
}) {
  const [editing,       setEditing]       = useState<ConditionalRule | null>(null)
  const [isNew,         setIsNew]         = useState(false)
  const [delConfirmId,  setDelConfirmId]  = useState<string | null>(null)

  const blankRule = (): ConditionalRule => ({
    id: makeRuleId(), sourceFieldId: '', operator: 'equals',
    value: '', action: 'show', targetFieldId: '', enabled: true,
  })

  const addRule = () => { setEditing(blankRule()); setIsNew(true) }

  const saveRule = (rule: ConditionalRule) => {
    if (!rule.sourceFieldId || !rule.targetFieldId) return
    onChange(isNew ? [...rules, rule] : rules.map(r => r.id === rule.id ? rule : r))
    setEditing(null)
  }

  const deleteRule    = (id: string) => { onChange(rules.filter(r => r.id !== id)); setDelConfirmId(null) }
  const duplicateRule = (rule: ConditionalRule) => onChange([...rules, { ...rule, id: makeRuleId() }])
  const toggleRule    = (id: string) => onChange(rules.map(r => r.id === id ? { ...r, enabled: !r.enabled } : r))

  const fieldLabel = (id: string) => fields.find(f => f.id === id)?.label ?? null
  const isStale    = (id: string) => !!id && !fields.find(f => f.id === id)

  const activeCount   = rules.filter(r => r.enabled !== false).length
  const disabledCount = rules.length - activeCount

  const ruleDescription = (r: ConditionalRule): React.ReactNode => {
    const src = fieldLabel(r.sourceFieldId) ?? <em>deleted field</em>
    const tgt = fieldLabel(r.targetFieldId) ?? <em>deleted field</em>
    const op  = OPERATOR_LABELS[r.operator] ?? r.operator
    const act = ACTION_LABELS[r.action]     ?? r.action
    const noVal = r.operator === 'is_empty' || r.operator === 'is_not_empty'
    return (
      <span>
        If <span className="font-semibold">{src}</span>
        {' '}<span className="text-muted-foreground">{op}</span>
        {!noVal && <>{' '}<span className="font-semibold">"{r.value}"</span></>}
        {' '}→{' '}
        <span className={cn(
          'font-semibold',
          r.action === 'show' || r.action === 'enable' || r.action === 'make_optional'
            ? 'text-emerald-600' : r.action === 'hide' || r.action === 'disable'
            ? 'text-rose-500' : 'text-amber-600',
        )}>{act}</span>
        {' '}<span className="font-semibold">{tgt}</span>
      </span>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Info banner */}
      <div className="flex items-start gap-2.5 rounded-lg border border-primary/10 bg-primary/[0.04] px-4 py-3">
        <Zap className="mt-0.5 size-3.5 shrink-0 text-primary/70" aria-hidden />
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Dynamically show, hide, require, or disable fields based on the attendee's answers.
          Use the Preview button to test rules interactively.
        </p>
      </div>

      {fields.length < 2 ? (
        <SectionCard>
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <Zap className="size-8 text-muted-foreground/20" aria-hidden />
            <p className="text-[12.5px] font-semibold text-foreground">No fields to connect</p>
            <p className="text-[12px] text-muted-foreground max-w-[220px]">
              Add at least two fields in the Sections & Fields tab to create conditional rules.
            </p>
          </div>
        </SectionCard>
      ) : (
        <>
          {/* Summary row */}
          {rules.length > 0 && (
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: 'Total Rules',    value: rules.length,   className: 'text-foreground'   },
                { label: 'Active',         value: activeCount,    className: 'text-emerald-600'  },
                { label: 'Disabled',       value: disabledCount,  className: 'text-muted-foreground' },
              ].map(({ label, value, className }) => (
                <div key={label} className="rounded-xl border border-border bg-card px-3 py-2.5 text-center shadow-sm">
                  <p className={cn('text-[18px] font-bold', className)}>{value}</p>
                  <p className="text-[10.5px] text-muted-foreground">{label}</p>
                </div>
              ))}
            </div>
          )}

          {/* Rules list */}
          {rules.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
              {rules.map((rule, idx) => {
                const stale   = isStale(rule.sourceFieldId) || isStale(rule.targetFieldId)
                const isDel   = delConfirmId === rule.id
                const enabled = rule.enabled !== false
                return (
                  <div
                    key={rule.id}
                    className={cn(
                      'group flex items-start gap-3 border-b border-border/40 px-4 py-3 transition-colors last:border-0',
                      isDel ? 'bg-red-50/60' : !enabled ? 'bg-muted/[0.02]' : 'hover:bg-muted/[0.03]',
                    )}
                  >
                    {/* Rule number + enabled indicator */}
                    <div className="mt-0.5 flex shrink-0 flex-col items-center gap-1">
                      <span className="text-[10px] font-semibold text-muted-foreground/50">{idx + 1}</span>
                      <span className={cn(
                        'size-[7px] rounded-full',
                        enabled ? 'bg-emerald-500' : 'bg-muted-foreground/25',
                      )} />
                    </div>

                    {/* Description */}
                    <div className="min-w-0 flex-1">
                      <p className={cn('text-[12px]', !enabled && 'opacity-50')}>
                        {ruleDescription(rule)}
                      </p>
                      {stale && (
                        <div className="mt-1 flex items-center gap-1 text-[11px] text-amber-600">
                          <AlertTriangle className="size-3 shrink-0" aria-hidden />
                          References a deleted field — update or remove this rule
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex shrink-0 items-center gap-1">
                      {isDel ? (
                        <>
                          <button type="button" onClick={() => deleteRule(rule.id)}
                            className="rounded bg-red-500 px-2 py-0.5 text-[10.5px] font-semibold text-white hover:bg-red-600">
                            Delete
                          </button>
                          <button type="button" onClick={() => setDelConfirmId(null)}
                            className="rounded px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:bg-muted/50">
                            ✕
                          </button>
                        </>
                      ) : (
                        <>
                          {/* Enable / disable toggle */}
                          <button
                            type="button" role="switch" aria-checked={enabled}
                            onClick={() => toggleRule(rule.id)}
                            title={enabled ? 'Disable rule' : 'Enable rule'}
                            className={cn(
                              'relative inline-flex h-[18px] w-[32px] shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200',
                              enabled ? 'bg-primary' : 'bg-muted-foreground/30',
                            )}
                          >
                            <span className={cn(
                              'inline-block size-[14px] rounded-full bg-white shadow-sm transition-transform duration-200',
                              enabled ? 'translate-x-[14px]' : 'translate-x-0',
                            )} />
                          </button>
                          <button type="button" onClick={() => { setEditing({ ...rule }); setIsNew(false) }}
                            className="flex size-6 items-center justify-center rounded text-muted-foreground/40 hover:bg-primary/10 hover:text-primary"
                            aria-label="Edit rule">
                            <Pencil className="size-3" aria-hidden />
                          </button>
                          <button type="button" onClick={() => duplicateRule(rule)}
                            className="flex size-6 items-center justify-center rounded text-muted-foreground/40 hover:bg-muted/60 hover:text-foreground"
                            aria-label="Duplicate rule">
                            <Copy className="size-3" aria-hidden />
                          </button>
                          <button type="button" onClick={() => setDelConfirmId(rule.id)}
                            className="flex size-6 items-center justify-center rounded text-muted-foreground/40 hover:bg-red-50 hover:text-red-500"
                            aria-label="Delete rule">
                            <Trash2 className="size-3" aria-hidden />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <button
            type="button"
            onClick={addRule}
            className={cn(
              buttonVariants({ variant: 'outline' }),
              'w-full gap-2 border-dashed border-primary/30 text-primary hover:border-primary/60 hover:bg-primary/[0.03]',
            )}
          >
            <Plus className="size-4" aria-hidden />
            Add Conditional Rule
          </button>
        </>
      )}

      {/* Rule edit / add modal */}
      <AnimatePresence>
        {editing && (
          <RuleEditModal
            rule={editing}
            fields={fields}
            allRules={rules}
            onSave={saveRule}
            onCancel={() => setEditing(null)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

function RuleEditModal({ rule, fields, allRules, onSave, onCancel }: {
  rule:     ConditionalRule
  fields:   FormField[]
  allRules: ConditionalRule[]
  onSave:   (r: ConditionalRule) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<ConditionalRule>({ ...rule })
  const upd = (p: Partial<ConditionalRule>) => setDraft(prev => ({ ...prev, ...p }))

  const needsValue  = !['is_empty', 'is_not_equals'].includes(draft.operator)
    && draft.operator !== 'is_not_empty'
  const otherRules  = allRules.filter(r => r.id !== draft.id)
  const isCircular  = !!draft.sourceFieldId && !!draft.targetFieldId
    && hasCircularDependency(otherRules, draft.sourceFieldId, draft.targetFieldId)
  const srcDeleted  = !!draft.sourceFieldId && !fields.find(f => f.id === draft.sourceFieldId)
  const tgtDeleted  = !!draft.targetFieldId && !fields.find(f => f.id === draft.targetFieldId)
  const canSave     = !!draft.sourceFieldId && !!draft.targetFieldId
    && (draft.sourceFieldId !== draft.targetFieldId)
    && (!needsValue || !!draft.value.trim())
    && !isCircular

  return (
    <>
      <motion.div key="rl-bd" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 bg-black/40" onClick={onCancel} aria-hidden />
      <motion.div
        key="rl-md"
        initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
        transition={{ duration: 0.25, ease: EASE }}
        className="fixed inset-x-0 bottom-0 top-12 z-50 mx-auto flex max-w-lg flex-col rounded-t-2xl border border-border bg-background shadow-xl sm:inset-x-4 sm:bottom-8 sm:top-auto sm:max-h-[90vh] sm:rounded-xl"
        role="dialog" aria-modal aria-label={rule.id ? 'Edit conditional rule' : 'Add conditional rule'}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3.5">
          <p className="text-[14px] font-bold text-foreground">
            {draft.sourceFieldId ? 'Edit Rule' : 'Add Rule'}
          </p>
          <button type="button" onClick={onCancel} className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/50">
            <X className="size-4" aria-hidden />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-5">
          <div className="flex flex-col gap-5">

            {/* WHEN block */}
            <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
              <p className="mb-3 text-[11px] font-bold uppercase tracking-widest text-primary">When</p>
              <div className="flex flex-col gap-3">
                <div>
                  <label className={labelCls}>Source Field</label>
                  <select className={inputCls} value={draft.sourceFieldId}
                    onChange={e => upd({ sourceFieldId: e.target.value, targetFieldId: draft.targetFieldId === e.target.value ? '' : draft.targetFieldId })}>
                    <option value="">Select a field…</option>
                    {fields.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
                  </select>
                  {srcDeleted && (
                    <p className="mt-1 flex items-center gap-1 text-[11px] text-amber-600">
                      <AlertTriangle className="size-3 shrink-0" /> This field has been deleted
                    </p>
                  )}
                </div>

                <div>
                  <label className={labelCls}>Condition</label>
                  <select className={inputCls} value={draft.operator}
                    onChange={e => upd({ operator: e.target.value as ConditionalRule['operator'] })}>
                    <optgroup label="Equality">
                      <option value="equals">equals</option>
                      <option value="not_equals">does not equal</option>
                    </optgroup>
                    <optgroup label="Text">
                      <option value="contains">contains</option>
                      <option value="not_contains">does not contain</option>
                    </optgroup>
                    <optgroup label="Numeric">
                      <option value="greater_than">is greater than</option>
                      <option value="less_than">is less than</option>
                    </optgroup>
                    <optgroup label="Presence">
                      <option value="is_empty">is empty</option>
                      <option value="is_not_empty">is not empty</option>
                    </optgroup>
                  </select>
                </div>

                {needsValue && (
                  <div>
                    <label className={labelCls}>Value</label>
                    <input className={inputCls} placeholder="e.g. Yes, Team, Invoice…"
                      value={draft.value} onChange={e => upd({ value: e.target.value })} />
                    <p className={hintCls}>Case-insensitive comparison</p>
                  </div>
                )}
              </div>
            </div>

            {/* THEN block */}
            <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
              <p className="mb-3 text-[11px] font-bold uppercase tracking-widest text-primary">Then</p>
              <div className="flex flex-col gap-3">
                <div>
                  <label className={labelCls}>Action</label>
                  <select className={inputCls} value={draft.action}
                    onChange={e => upd({ action: e.target.value as ConditionalRule['action'] })}>
                    <optgroup label="Visibility">
                      <option value="show">Show Field</option>
                      <option value="hide">Hide Field</option>
                    </optgroup>
                    <optgroup label="Requirement">
                      <option value="require">Make Required</option>
                      <option value="make_optional">Make Optional</option>
                    </optgroup>
                    <optgroup label="Interaction">
                      <option value="enable">Enable Field</option>
                      <option value="disable">Disable Field</option>
                    </optgroup>
                  </select>
                </div>

                <div>
                  <label className={labelCls}>Target Field</label>
                  <select className={inputCls} value={draft.targetFieldId}
                    onChange={e => upd({ targetFieldId: e.target.value })}>
                    <option value="">Select a field…</option>
                    {fields
                      .filter(f => f.id !== draft.sourceFieldId)
                      .map(f => <option key={f.id} value={f.id}>{f.label}</option>)
                    }
                  </select>
                  {tgtDeleted && (
                    <p className="mt-1 flex items-center gap-1 text-[11px] text-amber-600">
                      <AlertTriangle className="size-3 shrink-0" /> This field has been deleted
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* Options */}
            <div className="rounded-xl border border-border/60 bg-muted/[0.03] px-4 py-3">
              <Toggle
                checked={draft.enabled !== false}
                onChange={v => upd({ enabled: v })}
                label="Rule Enabled"
                desc="Disabled rules are saved but not evaluated"
              />
            </div>

            {/* Validation feedback */}
            {(isCircular || draft.sourceFieldId === draft.targetFieldId) && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-200/60 bg-amber-50/50 px-3 py-2.5">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" aria-hidden />
                <p className="text-[11.5px] leading-relaxed text-amber-700">
                  {draft.sourceFieldId === draft.targetFieldId
                    ? 'Source and target field cannot be the same.'
                    : 'This rule creates a circular dependency and cannot be saved.'}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button type="button" onClick={onCancel} className={buttonVariants({ variant: 'outline' })}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => canSave && onSave(draft)}
            disabled={!canSave}
            className={cn(buttonVariants({ variant: 'primary' }), 'min-w-[90px]', !canSave && 'cursor-not-allowed opacity-50')}
          >
            Save Rule
          </button>
        </div>
      </motion.div>
    </>
  )
}

// ─── Field Edit Modal ─────────────────────────────────────────────────────────

function FieldEditModal({ field, isNew, onSave, onCancel, passes = [], sectionId, sections = [] }: {
  field:     FormField
  isNew:     boolean
  onSave:    (f: FormField, targetSectionId?: string) => void
  onCancel:  () => void
  passes?:   PassSummary[]
  sectionId?:string
  sections?: { id: string; title: string }[]
}) {
  const [draft,           setDraft]           = useState<FormField>({ ...field, options: [...field.options] })
  const [optDraft,        setOptDraft]        = useState('')
  const [targetSectionId, setTargetSectionId] = useState<string>(sectionId ?? '')
  const optRef = useRef<HTMLInputElement>(null)

  const upd = (p: Partial<FormField>) => setDraft(prev => ({ ...prev, ...p }))

  const hasOptions = ['dropdown', 'radio', 'checkbox', 'multiselect'].includes(draft.type)

  const addOption = () => {
    const v = optDraft.trim()
    if (!v || draft.options.includes(v)) return
    upd({ options: [...draft.options, v] })
    setOptDraft('')
    optRef.current?.focus()
  }

  const removeOption = (opt: string) => upd({ options: draft.options.filter(o => o !== opt) })

  const canSave = draft.label.trim().length > 0

  return (
    <>
      <motion.div key="fe-bd" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 bg-black/40" onClick={onCancel} aria-hidden />
      <motion.div key="fe-md"
        initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
        transition={{ duration: 0.25, ease: EASE }}
        className="fixed inset-x-0 bottom-0 top-12 z-50 mx-auto flex max-w-lg flex-col rounded-t-2xl border border-border bg-background shadow-xl sm:inset-x-4 sm:bottom-8 sm:top-auto sm:max-h-[85vh] sm:rounded-xl"
        role="dialog" aria-modal aria-label={isNew ? 'Add field' : 'Edit field'}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3.5">
          <p className="text-[14px] font-bold text-foreground">{isNew ? 'Add Field' : 'Edit Field'}</p>
          <button type="button" onClick={onCancel} className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/50">
            <X className="size-4" aria-hidden />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-5">
          <div className="flex flex-col gap-4">

            {/* Move to Section — only when editing an existing field and multiple sections exist */}
            {!isNew && sections.length > 1 && (
              <div>
                <label className={labelCls}>Section</label>
                <select className={inputCls} value={targetSectionId} onChange={e => setTargetSectionId(e.target.value)}>
                  {sections.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
                </select>
                <p className={hintCls}>Move this field to a different section</p>
              </div>
            )}

            {/* Label */}
            <div>
              <label className={labelCls}>Field Label <span className="text-red-500">*</span></label>
              <input
                className={inputCls}
                placeholder="e.g. Full Name, Company, T-Shirt Size…"
                value={draft.label}
                onChange={e => upd({ label: e.target.value })}
                autoFocus
                maxLength={80}
              />
            </div>

            {/* Type */}
            <div>
              <label className={labelCls}>Field Type</label>
              <select className={inputCls} value={draft.type} onChange={e => upd({ type: e.target.value as FieldType, options: [] })}>
                {FIELD_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </div>

            {/* Section */}
            <div>
              <label className={labelCls}>Section <span className={hintCls.replace('mt-1 ', '')}>(optional — for grouping fields)</span></label>
              <input
                className={inputCls}
                placeholder="e.g. basic, billing, sports"
                value={draft.section}
                onChange={e => upd({ section: e.target.value })}
                maxLength={30}
              />
            </div>

            {/* Placeholder */}
            <div>
              <label className={labelCls}>Placeholder Text</label>
              <input className={inputCls} placeholder="e.g. Enter your full name…" value={draft.placeholder} onChange={e => upd({ placeholder: e.target.value })} maxLength={100} />
            </div>

            {/* Helper text */}
            <div>
              <label className={labelCls}>Helper Text</label>
              <input className={inputCls} placeholder="e.g. Required for age-category validation" value={draft.helperText} onChange={e => upd({ helperText: e.target.value })} maxLength={120} />
            </div>

            {/* Options — dropdown / radio / checkbox / multiselect */}
            {hasOptions && (
              <div>
                <label className={labelCls}>Options</label>
                {draft.options.length > 0 && (
                  <div className="mb-2 flex flex-col gap-1">
                    {draft.options.map(opt => (
                      <div key={opt} className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/[0.03] px-3 py-1.5">
                        <span className="text-[12.5px] text-foreground">{opt}</span>
                        <button type="button" onClick={() => removeOption(opt)}
                          className="flex size-5 items-center justify-center rounded text-muted-foreground/40 hover:bg-red-50 hover:text-red-500">
                          <X className="size-3.5" aria-hidden />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
                  <input
                    ref={optRef}
                    className={cn(inputCls, 'flex-1')}
                    placeholder="Add option…"
                    value={optDraft}
                    onChange={e => setOptDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addOption() } }}
                    maxLength={60}
                  />
                  <button type="button" onClick={addOption} disabled={!optDraft.trim()}
                    className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'shrink-0', !optDraft.trim() && 'pointer-events-none opacity-50')}>
                    <Plus className="size-3.5" aria-hidden />
                  </button>
                </div>
              </div>
            )}

            {/* Pass Visibility */}
            <div className="flex flex-col gap-2.5 rounded-lg border border-border/60 bg-muted/[0.03] px-4 py-3">
              <div>
                <p className="text-[12.5px] font-semibold text-foreground">Pass Visibility</p>
                <p className="mt-0.5 text-[11.5px] text-muted-foreground">Choose which passes show this field.</p>
              </div>

              {passes.length === 0 ? (
                <div className="flex items-start gap-2 rounded-lg border border-amber-200/60 bg-amber-50/50 px-3 py-2.5">
                  <Info className="mt-0.5 size-3.5 shrink-0 text-amber-500" aria-hidden />
                  <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                    No passes defined yet. Add passes in Step&nbsp;4 to enable per-pass field visibility.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {/* All passes */}
                  <label className="flex cursor-pointer items-start gap-2.5">
                    <input
                      type="radio"
                      checked={draft.passVisibility === 'all'}
                      onChange={() => upd({ passVisibility: 'all' })}
                      className="mt-0.5 size-[14px] cursor-pointer accent-primary"
                    />
                    <div>
                      <p className="text-[12.5px] font-medium text-foreground">All Passes</p>
                      <p className="text-[11.5px] text-muted-foreground">This field appears for every pass type</p>
                    </div>
                  </label>

                  {/* Specific passes */}
                  <label className="flex cursor-pointer items-start gap-2.5">
                    <input
                      type="radio"
                      checked={Array.isArray(draft.passVisibility)}
                      onChange={() => upd({ passVisibility: [] })}
                      className="mt-0.5 size-[14px] cursor-pointer accent-primary"
                    />
                    <div>
                      <p className="text-[12.5px] font-medium text-foreground">Specific Passes</p>
                      <p className="text-[11.5px] text-muted-foreground">Show only for selected passes below</p>
                    </div>
                  </label>

                  {/* Pass checkboxes (only when "Specific" is chosen) */}
                  {Array.isArray(draft.passVisibility) && (
                    <div className="ml-[22px] flex flex-col gap-1.5 pt-0.5">
                      {passes.map(pass => {
                        const pv      = draft.passVisibility as string[]
                        const checked = pv.includes(pass.id)
                        return (
                          <label key={pass.id} className="flex cursor-pointer items-center gap-2">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => {
                                const next = checked
                                  ? pv.filter(id => id !== pass.id)
                                  : [...pv, pass.id]
                                upd({ passVisibility: next })
                              }}
                              className="size-[14px] cursor-pointer accent-primary"
                            />
                            <span className="text-[12.5px] text-foreground">{pass.name}</span>
                          </label>
                        )
                      })}
                      {passes.length > 0 && (draft.passVisibility as string[]).length === 0 && (
                        <p className="text-[11px] text-amber-600">Select at least one pass.</p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Toggles */}
            <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-muted/[0.03] px-4 py-3">
              <Toggle checked={draft.required} onChange={v => upd({ required: v })} label="Required" desc="Attendee must fill this field to submit the form" />
              <Toggle checked={draft.visible}  onChange={v => upd({ visible:  v })} label="Visible"  desc="Show this field on the registration form" />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button type="button" onClick={onCancel} className={buttonVariants({ variant: 'outline' })}>Cancel</button>
          <button
            type="button"
            onClick={() => { if (canSave) onSave(draft, !isNew && targetSectionId !== sectionId ? targetSectionId : undefined) }}
            disabled={!canSave}
            className={cn(buttonVariants({ variant: 'primary' }), !canSave && 'cursor-not-allowed opacity-50')}
          >
            {isNew ? 'Add Field' : 'Save Changes'}
          </button>
        </div>
      </motion.div>
    </>
  )
}

// ─── Form Summary Panel ───────────────────────────────────────────────────────

function FormSummaryPanel({
  form,
  templates,
  passes = [],
  onPreview,
}: {
  form:      RegistrationFormDraft
  templates: FormTemplateConfig[]
  passes?:   PassSummary[]
  onPreview: () => void
}) {
  const templateLabel  = templates.find(t => t.id === form.template)?.label ?? null
  const sectionCount   = form.sections.length
  const totalFields    = form.fields.length
  const requiredCount  = form.fields.filter(f => f.required).length
  const optionalCount  = totalFields - requiredCount
  const customCount    = form.fields.filter(f => f.section === 'custom').length
  const passLinked     = form.fields.filter(f => Array.isArray(f.passVisibility)).length
  const activeRules    = form.conditionalRules.filter(r => r.enabled !== false).length
  const staleRules     = form.conditionalRules.filter(r => {
    const ids = form.fields.map(f => f.id)
    return !ids.includes(r.sourceFieldId) || !ids.includes(r.targetFieldId)
  }).length

  const Stat = ({ label, value, accent }: { label: string; value: number; accent?: boolean }) => (
    <div className="flex items-center justify-between gap-2">
      <p className="text-[12px] text-muted-foreground">{label}</p>
      <span className={cn(
        'min-w-[28px] rounded-full px-2 py-0.5 text-center text-[11px] font-bold',
        accent ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
      )}>{value}</span>
    </div>
  )

  return (
    <div className="flex flex-col gap-3">
      {/* Preview button */}
      <button
        type="button"
        onClick={onPreview}
        disabled={totalFields === 0}
        className={cn(
          buttonVariants({ variant: 'outline' }),
          'w-full gap-2',
          totalFields === 0 && 'pointer-events-none opacity-50',
        )}
      >
        <Eye className="size-4" aria-hidden />
        Preview Registration Form
      </button>

      {/* Summary card */}
      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <p className="mb-3 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Form Summary</p>

        {templateLabel ? (
          <div className="mb-3 flex items-center gap-2 rounded-lg bg-primary/[0.04] px-3 py-2">
            <ClipboardList className="size-3.5 shrink-0 text-primary/70" aria-hidden />
            <p className="text-[12px] font-medium text-foreground">{templateLabel}</p>
          </div>
        ) : (
          <div className="mb-3 flex items-center gap-2 rounded-lg bg-muted/30 px-3 py-2">
            <ClipboardList className="size-3.5 shrink-0 text-muted-foreground/40" aria-hidden />
            <p className="text-[12px] text-muted-foreground">No template selected</p>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <Stat label="Total Sections"     value={sectionCount}  accent={sectionCount > 0} />
          <Stat label="Total Fields"       value={totalFields}   accent={totalFields > 0} />
          <Stat label="Required Fields"    value={requiredCount} />
          <Stat label="Optional Fields"    value={optionalCount} />
          <Stat label="Custom Fields"      value={customCount} />
          <Stat label="Pass-Specific"      value={passLinked}                        accent={passLinked > 0} />
          <Stat label="Active Rules"       value={activeRules}                       accent={activeRules > 0} />
          <Stat label="Total Rules"        value={form.conditionalRules.length} />
        </div>
      </div>

      {/* Passes summary (shown only when passes are defined) */}
      {passes.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <p className="mb-3 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Passes</p>
          <div className="flex flex-col gap-1.5">
            {passes.map(pass => {
              const count = form.fields.filter(f =>
                Array.isArray(f.passVisibility) && f.passVisibility.includes(pass.id)
              ).length
              return (
                <div key={pass.id} className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Ticket className="size-3 shrink-0 text-muted-foreground/50" aria-hidden />
                    <p className="truncate text-[11.5px] text-foreground">{pass.name}</p>
                  </div>
                  <span className={cn(
                    'shrink-0 rounded-full px-2 py-px text-[10.5px] font-semibold',
                    count > 0 ? 'bg-sky-50 text-sky-600' : 'bg-muted text-muted-foreground',
                  )}>
                    {count} field{count !== 1 ? 's' : ''}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Stale rules warning */}
      {staleRules > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200/60 bg-amber-50/50 px-3 py-2.5">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" aria-hidden />
          <p className="text-[11.5px] leading-relaxed text-amber-700">
            {staleRules} rule{staleRules !== 1 ? 's reference' : ' references'} deleted fields. Open Conditional Logic to fix.
          </p>
        </div>
      )}

      {/* Registration rules summary */}
      {(() => {
        const rr = form.registrationRules
        if (!rr) return null
        const modLabel: Record<string, string> = { individual: 'Individual', team: 'Team Only', both: 'Both' }
        const dupLabel: Record<string, string> = { block: 'Blocked', warn: 'Warn', allow: 'Allowed' }
        const dupClass: Record<string, string> = {
          block: 'bg-rose-50 text-rose-600',
          warn:  'bg-amber-50 text-amber-700',
          allow: 'bg-muted text-muted-foreground',
        }
        return (
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <p className="mb-3 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
              Registration Rules
            </p>
            <div className="flex flex-col gap-2">
              {/* Labelled key-value pairs */}
              {[
                {
                  label: 'Reg Type',
                  badge: modLabel[rr.registrationMode] ?? rr.registrationMode,
                  cls:   'bg-primary/10 text-primary',
                },
                {
                  label: 'Approval',
                  badge: rr.approvalMode === 'manual' ? 'Manual' : 'Auto',
                  cls:   rr.approvalMode === 'manual'
                    ? 'bg-amber-50 text-amber-700'
                    : 'bg-emerald-50 text-emerald-700',
                },
                {
                  label: 'Duplicates',
                  badge: dupLabel[rr.duplicatePolicy] ?? rr.duplicatePolicy,
                  cls:   dupClass[rr.duplicatePolicy] ?? 'bg-muted text-muted-foreground',
                },
              ].map(({ label, badge, cls }) => (
                <div key={label} className="flex items-center justify-between gap-2">
                  <p className="text-[11.5px] text-muted-foreground">{label}</p>
                  <span className={cn('rounded-full px-2 py-0.5 text-[10.5px] font-semibold', cls)}>{badge}</span>
                </div>
              ))}
              {/* Boolean indicators */}
              {[
                { label: 'Waitlist',            on: rr.waitlistEnabled            },
                { label: 'Require Login',        on: rr.requireLogin               },
                { label: 'Guest Registration',   on: rr.allowGuestRegistration     },
                { label: 'Email Verification',   on: rr.requireEmailVerification   },
                { label: 'Mobile Verification',  on: rr.requireMobileVerification  },
                { label: 'File Uploads',         on: rr.allowFileUpload            },
              ].map(({ label, on }) => (
                <div key={label} className="flex items-center gap-2">
                  <span className={cn('size-1.5 shrink-0 rounded-full', on ? 'bg-emerald-500' : 'bg-muted-foreground/20')} />
                  <p className={cn('text-[11.5px]', on ? 'text-foreground' : 'text-muted-foreground/50')}>{label}</p>
                </div>
              ))}
            </div>
          </div>
        )
      })()}
    </div>
  )
}

// ─── Form Preview Modal ───────────────────────────────────────────────────────

function PreviewFieldInput({ field }: { field: FormField }) {
  const base = 'w-full rounded-lg border border-border bg-muted/20 px-3 py-2 text-[12.5px] text-foreground/50 outline-none'
  const { type, label, placeholder, helperText, options, required } = field

  const lbl = (
    <label className="mb-1 block text-[12px] font-medium text-foreground">
      {label}
      {required && <span className="ml-0.5 text-red-400">*</span>}
    </label>
  )

  if (type === 'textarea' || type === 'address') return (
    <div>
      {lbl}
      <textarea rows={3} disabled placeholder={placeholder || `Enter ${label.toLowerCase()}…`} className={cn(base, 'h-20 resize-none py-2')} />
      {helperText && <p className={hintCls}>{helperText}</p>}
    </div>
  )

  if (type === 'dropdown') return (
    <div>
      {lbl}
      <select disabled className={base}><option>{placeholder || `Select ${label.toLowerCase()}…`}</option></select>
      {helperText && <p className={hintCls}>{helperText}</p>}
    </div>
  )

  if (type === 'radio' || type === 'yesno') {
    const opts = type === 'yesno' ? ['Yes', 'No'] : options
    return (
      <div>
        {lbl}
        <div className="flex flex-wrap gap-3">
          {opts.map(o => (
            <label key={o} className="flex items-center gap-1.5 text-[12px] text-foreground/60 cursor-not-allowed">
              <input type="radio" disabled className="accent-primary" />
              {o}
            </label>
          ))}
        </div>
        {helperText && <p className={hintCls}>{helperText}</p>}
      </div>
    )
  }

  if (type === 'checkbox' || type === 'multiselect') return (
    <div>
      {lbl}
      <div className="flex flex-col gap-1.5">
        {(options.length > 0 ? options : [label]).map(o => (
          <label key={o} className="flex items-center gap-2 text-[12px] text-foreground/60 cursor-not-allowed">
            <input type="checkbox" disabled className="accent-primary rounded" />
            {o}
          </label>
        ))}
      </div>
      {helperText && <p className={hintCls}>{helperText}</p>}
    </div>
  )

  if (type === 'file') return (
    <div>
      {lbl}
      <div className={cn(base, 'flex items-center justify-center py-5 border-dashed text-[11.5px]')}>
        Click to upload or drag file here
      </div>
      {helperText && <p className={hintCls}>{helperText}</p>}
    </div>
  )

  const htmlType =
    type === 'email'  ? 'email'
    : type === 'mobile' ? 'tel'
    : type === 'number' ? 'number'
    : type === 'date'   ? 'date'
    : type === 'time'   ? 'time'
    : type === 'url'    ? 'url'
    : 'text'

  return (
    <div>
      {lbl}
      <input type={htmlType} disabled placeholder={placeholder || `Enter ${label.toLowerCase()}…`} className={base} />
      {helperText && <p className={hintCls}>{helperText}</p>}
    </div>
  )
}

// ─── Interactive field renderer for the live preview ─────────────────────────

function LivePreviewField({
  field,
  value,
  onChange,
  disabled,
  required,
}: {
  field:    FormField
  value:    string
  onChange: (v: string) => void
  disabled: boolean
  required: boolean
}) {
  const { type, label, placeholder, helperText, options } = field
  const base = cn(
    'w-full rounded-lg border border-border bg-background px-3 py-2 text-[12.5px] text-foreground outline-none transition-colors',
    disabled
      ? 'cursor-not-allowed bg-muted/30 opacity-50'
      : 'focus:border-primary/50 focus:ring-2 focus:ring-primary/20',
  )
  const lbl = (
    <label className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-foreground">
      {label}
      {required && <span className="text-red-400">*</span>}
      {disabled && <span className="ml-1 text-[10.5px] font-normal text-muted-foreground/50">(disabled)</span>}
    </label>
  )

  if (type === 'textarea' || type === 'address') return (
    <div>
      {lbl}
      <textarea rows={3} disabled={disabled} placeholder={placeholder || `Enter ${label.toLowerCase()}…`}
        className={cn(base, 'h-20 resize-none')} value={value} onChange={e => onChange(e.target.value)} />
      {helperText && <p className={hintCls}>{helperText}</p>}
    </div>
  )

  if (type === 'dropdown') return (
    <div>
      {lbl}
      <select disabled={disabled} className={base} value={value} onChange={e => onChange(e.target.value)}>
        <option value="">{placeholder || `Select ${label.toLowerCase()}…`}</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
      {helperText && <p className={hintCls}>{helperText}</p>}
    </div>
  )

  if (type === 'radio' || type === 'yesno') {
    const opts = type === 'yesno' ? ['Yes', 'No'] : options
    return (
      <div>
        {lbl}
        <div className="flex flex-wrap gap-3">
          {opts.map(o => (
            <label key={o} className={cn('flex items-center gap-1.5 text-[12px] text-foreground cursor-pointer', disabled && 'cursor-not-allowed opacity-50')}>
              <input type="radio" name={field.id} disabled={disabled} checked={value === o}
                onChange={() => onChange(o)} className="accent-primary" />
              {o}
            </label>
          ))}
        </div>
        {helperText && <p className={hintCls}>{helperText}</p>}
      </div>
    )
  }

  if (type === 'checkbox' || type === 'multiselect') {
    const selected = value ? value.split(',').map(v => v.trim()).filter(Boolean) : []
    const toggle   = (opt: string) => {
      const next = selected.includes(opt) ? selected.filter(s => s !== opt) : [...selected, opt]
      onChange(next.join(', '))
    }
    return (
      <div>
        {lbl}
        <div className="flex flex-col gap-1.5">
          {(options.length > 0 ? options : [label]).map(o => (
            <label key={o} className={cn('flex items-center gap-2 text-[12px] text-foreground cursor-pointer', disabled && 'cursor-not-allowed opacity-50')}>
              <input type="checkbox" disabled={disabled} checked={selected.includes(o)}
                onChange={() => toggle(o)} className="accent-primary rounded" />
              {o}
            </label>
          ))}
        </div>
        {helperText && <p className={hintCls}>{helperText}</p>}
      </div>
    )
  }

  if (type === 'file') return (
    <div>
      {lbl}
      <div className={cn(base, 'flex items-center justify-center py-5 border-dashed text-[11.5px] text-muted-foreground/50 cursor-not-allowed')}>
        Click to upload or drag file here
      </div>
      {helperText && <p className={hintCls}>{helperText}</p>}
    </div>
  )

  const htmlType = type === 'email' ? 'email' : type === 'mobile' ? 'tel'
    : type === 'number' ? 'number' : type === 'date' ? 'date'
    : type === 'time'   ? 'time'   : type === 'url'  ? 'url' : 'text'

  return (
    <div>
      {lbl}
      <input type={htmlType} disabled={disabled} placeholder={placeholder || `Enter ${label.toLowerCase()}…`}
        className={base} value={value} onChange={e => onChange(e.target.value)} />
      {helperText && <p className={hintCls}>{helperText}</p>}
    </div>
  )
}

// ─── Form Preview Modal (interactive — evaluates conditional rules) ────────────

function FormPreviewModal({
  form,
  passes = [],
  onClose,
}: {
  form:    RegistrationFormDraft
  passes?: PassSummary[]
  onClose: () => void
}) {
  const [selectedPassId, setSelectedPassId] = useState<string | null>(null)
  const [fieldValues,    setFieldValues]    = useState<Record<string, string>>({})

  const setValue = (id: string, v: string) =>
    setFieldValues(prev => ({ ...prev, [id]: v }))

  // Evaluate all rules against current values
  const ruleState = applyRules(form.fields, form.conditionalRules, fieldValues)

  // Active rules count for the indicator
  const activeRuleCount = form.conditionalRules.filter(r => {
    if (r.enabled === false) return false
    return evaluateRule(r, fieldValues)
  }).length

  // Per-section, per-field visibility (pass filter + rule state)
  const isFieldVisible = (f: FormField): boolean => {
    if (!f.visible) return false
    const pv = f.passVisibility ?? 'all'
    if (pv !== 'all' && selectedPassId !== null && !(pv as string[]).includes(selectedPassId)) return false
    return ruleState.get(f.id)?.visible !== false
  }

  const totalVisible = form.fields.filter(isFieldVisible).length

  return (
    <>
      <motion.div key="pv-bd" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 bg-black/50" onClick={onClose} aria-hidden />

      <motion.div key="pv-md"
        initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }}
        transition={{ duration: 0.25, ease: EASE }}
        className="fixed inset-x-4 bottom-4 top-4 z-50 mx-auto flex max-w-[560px] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
        role="dialog" aria-modal aria-label="Registration form preview"
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-border bg-muted/[0.03] px-6 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10">
              <Eye className="size-4 text-primary" aria-hidden />
            </div>
            <div>
              <p className="text-[14px] font-bold text-foreground">Registration Form Preview</p>
              <p className="text-[11.5px] text-muted-foreground">
                Interactive — fill fields to test conditional rules
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose}
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/50 hover:text-foreground">
            <X className="size-5" aria-hidden />
          </button>
        </div>

        {/* Pass selector */}
        {passes.length > 0 && (
          <div className="shrink-0 border-b border-border px-6 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-muted-foreground shrink-0">
                <Ticket className="size-3.5 shrink-0" aria-hidden />
                Pass:
              </div>
              {[{ id: null, name: 'All Passes' }, ...passes].map(p => (
                <button key={String(p.id)} type="button" onClick={() => setSelectedPassId(p.id)}
                  className={cn(
                    'rounded-full border px-2.5 py-[3px] text-[11.5px] font-medium transition-colors',
                    selectedPassId === p.id
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border text-muted-foreground hover:border-primary/40 hover:text-foreground',
                  )}>
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Active rules indicator */}
        {form.conditionalRules.length > 0 && (
          <div className="shrink-0 border-b border-border/60 bg-primary/[0.03] px-6 py-2">
            <div className="flex items-center gap-2">
              <Zap className="size-3 shrink-0 text-primary/60" aria-hidden />
              <p className="text-[11.5px] text-muted-foreground">
                <span className="font-semibold text-primary">{activeRuleCount}</span>
                {' '}of {form.conditionalRules.filter(r => r.enabled !== false).length} rules{' '}
                currently active
                {activeRuleCount > 0 && ' — fields are being shown/hidden/modified'}
              </p>
            </div>
          </div>
        )}

        {/* Sections + fields */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {totalVisible === 0 ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <ListChecks className="size-10 text-muted-foreground/20" aria-hidden />
              <p className="text-[13px] text-muted-foreground">
                {selectedPassId ? 'No fields configured for this pass.' : 'No visible fields to preview.'}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              {form.sections.map(section => {
                const sectionFields = section.fields.filter(isFieldVisible)
                if (sectionFields.length === 0) return null
                return (
                  <div key={section.id}>
                    {/* Section header */}
                    <div className="mb-3 flex items-center gap-2">
                      <div className="h-px flex-1 bg-border" />
                      <span className="shrink-0 rounded-full border border-border bg-muted/30 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {section.title}
                      </span>
                      <div className="h-px flex-1 bg-border" />
                    </div>
                    <div className="flex flex-col gap-4">
                      {sectionFields.map(field => {
                        const state = ruleState.get(field.id)
                        return (
                          <LivePreviewField
                            key={field.id}
                            field={field}
                            value={fieldValues[field.id] ?? ''}
                            onChange={v => setValue(field.id, v)}
                            disabled={state?.disabled ?? false}
                            required={state?.required ?? field.required}
                          />
                        )
                      })}
                    </div>
                  </div>
                )
              })}
              {/* Flat fields not in any section */}
              {(() => {
                const sectionFieldIds = new Set(form.sections.flatMap(s => s.fields.map(f => f.id)))
                const orphans = form.fields.filter(f => !sectionFieldIds.has(f.id) && isFieldVisible(f))
                if (orphans.length === 0) return null
                return (
                  <div className="flex flex-col gap-4">
                    {orphans.map(field => {
                      const state = ruleState.get(field.id)
                      return (
                        <LivePreviewField key={field.id} field={field}
                          value={fieldValues[field.id] ?? ''} onChange={v => setValue(field.id, v)}
                          disabled={state?.disabled ?? false} required={state?.required ?? field.required}
                        />
                      )
                    })}
                  </div>
                )
              })()}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-border px-6 py-4">
          <button type="button" disabled
            className={cn(buttonVariants({ variant: 'primary' }), 'w-full cursor-not-allowed opacity-60')}>
            Submit Registration
          </button>
          <p className="mt-2 text-center text-[11px] text-muted-foreground">
            Preview only — submit is disabled
          </p>
        </div>
      </motion.div>
    </>
  )
}

// ─── Template Replace Confirmation Modal ─────────────────────────────────────

function TemplateReplaceModal({
  template,
  sectionsCount,
  fieldsCount,
  rulesCount,
  onReplaceAll,
  onReplaceFieldsOnly,
  onCancel,
}: {
  template:           FormTemplateConfig
  sectionsCount:      number
  fieldsCount:        number
  rulesCount:         number
  onReplaceAll:       () => void
  onReplaceFieldsOnly:() => void
  onCancel:           () => void
}) {
  const items = [
    { label: 'Sections', value: sectionsCount, show: sectionsCount > 0 },
    { label: 'Fields',   value: fieldsCount,   show: fieldsCount > 0 },
    { label: 'Conditional Rules', value: rulesCount, show: rulesCount > 0 },
  ].filter(x => x.show)

  return (
    <>
      <motion.div key="tr-bd" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 bg-black/40" onClick={onCancel} aria-hidden />
      <motion.div
        key="tr-md"
        initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.97 }} transition={{ duration: 0.18, ease: EASE }}
        className="fixed inset-x-4 top-1/2 z-50 mx-auto max-w-[400px] -translate-y-1/2 overflow-hidden rounded-xl border border-border bg-background shadow-xl"
        role="dialog" aria-modal aria-label="Replace form template"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <p className="text-[14px] font-bold text-foreground">Replace Form Template?</p>
          <button type="button" onClick={onCancel}
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/50">
            <X className="size-4" aria-hidden />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4">
          {items.length > 0 && (
            <div className="mb-4 rounded-lg border border-amber-200/60 bg-amber-50/50 px-4 py-3">
              <p className="mb-1.5 text-[12px] font-semibold text-foreground">
                Your current form has:
              </p>
              <div className="flex flex-col gap-1">
                {items.map(({ label, value }) => (
                  <div key={label} className="flex items-center gap-2 text-[12px] text-muted-foreground">
                    <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />
                    <span className="font-semibold text-foreground">{value}</span> {label}
                  </div>
                ))}
              </div>
            </div>
          )}
          <p className="text-[12.5px] text-muted-foreground">
            Applying{' '}
            <span className="font-semibold text-foreground">"{template.label}"</span>
            {' '}will generate new sections and fields. Choose how to handle your existing content.
          </p>
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-2 border-t border-border px-5 py-4">
          <button type="button" onClick={onReplaceAll}
            className={cn(buttonVariants({ variant: 'primary' }), 'w-full gap-2')}>
            Replace Everything
            <span className="text-[11px] opacity-75">fields, sections &amp; rules</span>
          </button>
          <button type="button" onClick={onReplaceFieldsOnly}
            className={cn(buttonVariants({ variant: 'outline' }), 'w-full gap-2')}>
            Replace Sections &amp; Fields Only
            <span className="text-[11px] text-muted-foreground">keep rules &amp; settings</span>
          </button>
          <button type="button" onClick={onCancel}
            className={cn(buttonVariants({ variant: 'outline' }), 'w-full text-muted-foreground')}>
            Cancel
          </button>
        </div>
      </motion.div>
    </>
  )
}

// ─── RegistrationFormBuilder (main export) ────────────────────────────────────

export interface RegistrationFormBuilderProps {
  form:                RegistrationFormDraft
  onChange:            (f: RegistrationFormDraft) => void
  eventTypeId?:        string | null
  eventSubtype?:       string | null
  passes?:             PassSummary[]
  /** Confirmation mode set in Step 3. When provided, the Settings tab shows an
   *  Approval Mode Source selector so the user can sync or override. */
  syncedApprovalMode?: 'auto' | 'manual' | null
}

export function RegistrationFormBuilder({
  form: rawForm,
  onChange,
  eventTypeId,
  eventSubtype,
  passes = [],
  syncedApprovalMode = null,
}: RegistrationFormBuilderProps) {
  // ── Normalize raw draft data from Firestore ──────────────────────────────────
  // Guarantees safe defaults; back-fills passVisibility; migrates legacy flat
  // fields arrays into a single default section if sections is missing.
  const raw = rawForm as Partial<RegistrationFormDraft> | null | undefined

  const normalizeField = (f: FormField): FormField => ({
    ...f,
    passVisibility: f.passVisibility ?? 'all',
    options:        f.options ?? [],
  })

  const rawSections: FormSection[] = (raw?.sections ?? []).map(s => ({
    ...s,
    fields: s.fields.map(normalizeField),
  }))

  const rawFields: FormField[] = (raw?.fields ?? []).map(normalizeField)

  // Prefer sections; fall back to migrating legacy flat fields
  const resolvedSections: FormSection[] =
    rawSections.length > 0
      ? rawSections
      : rawFields.length > 0
        ? migrateFieldsToSections(rawFields)
        : []

  // Resolve registrationRules — migrate from legacy FormSettings if missing
  const rawRR = raw?.registrationRules as Partial<RegistrationRules> | null | undefined
  const registrationRules: RegistrationRules = rawRR
    ? {
        ...BLANK_REGISTRATION_RULES,
        ...rawRR,
        teamSettings: { ...BLANK_TEAM_SETTINGS, ...(rawRR.teamSettings ?? {}) },
      }
    : {
        ...BLANK_REGISTRATION_RULES,
        limitPerEmail:          raw?.settings?.oneRegistrationPerEmail  ?? true,
        limitPerMobile:         raw?.settings?.oneRegistrationPerMobile ?? false,
        approvalMode:           (raw?.settings?.requireApproval ? 'manual' : 'auto') as 'auto' | 'manual',
        requireLogin:           raw?.settings?.requireLogin             ?? false,
        allowGuestRegistration: raw?.settings?.allowGuestRegistration   ?? false,
        allowFileUpload:        raw?.settings?.allowFileUpload          ?? false,
      }

  // Derive FormSettings from RegistrationRules so the two are never out of sync
  const syncedSettings: typeof BLANK_FORM_SETTINGS = {
    ...(raw?.settings ?? { ...BLANK_FORM_SETTINGS }),
    requireApproval:          registrationRules.approvalMode === 'manual',
    requireLogin:             registrationRules.requireLogin,
    allowGuestRegistration:   registrationRules.allowGuestRegistration,
    allowFileUpload:          registrationRules.allowFileUpload,
    oneRegistrationPerEmail:  registrationRules.limitPerEmail,
    oneRegistrationPerMobile: registrationRules.limitPerMobile,
  }

  const form: RegistrationFormDraft = {
    template:          raw?.template         ?? '',
    sections:          resolvedSections,
    fields:            deriveFields(resolvedSections),
    settings:          syncedSettings,
    registrationRules,
    // Back-fill `enabled` for rules saved before the conditional logic engine
    conditionalRules: (raw?.conditionalRules ?? []).map(r => ({
      ...r,
      enabled: (r as ConditionalRule & { enabled?: boolean }).enabled !== false,
    })),
  }

  // ── Local state ───────────────────────────────────────────────────────────────
  const [activeTab,           setActiveTab]           = useState<Tab>('template')
  const [editingField,        setEditingField]        = useState<FormField | null>(null)
  const [editingSectionId,    setEditingSectionId]    = useState<string | null>(null)
  const [isNewField,          setIsNewField]          = useState(false)
  const [previewOpen,         setPreviewOpen]         = useState(false)
  const [confirmingTemplate,  setConfirmingTemplate]  = useState<FormTemplateConfig | null>(null)
  // 'synced'  → approvalMode is driven by Step 3's confirmationMode (locked in UI)
  // 'override'→ user has chosen a different approval mode for this form
  const [approvalModeSource, setApprovalModeSource] = useState<'synced' | 'override'>(
    syncedApprovalMode != null &&
    form.registrationRules.approvalMode === syncedApprovalMode
      ? 'synced' : 'override',
  )

  const templates = getFormTemplates(eventTypeId, eventSubtype)

  // update() keeps derived flat fields AND the legacy FormSettings in sync.
  // RegistrationRules is the single source of truth; FormSettings is derived.
  const update = (partial: Partial<RegistrationFormDraft>) => {
    const next = { ...form, ...partial }
    if (partial.sections) {
      next.fields = deriveFields(next.sections)
    }
    if (partial.registrationRules) {
      const rr = next.registrationRules
      next.settings = {
        ...next.settings,
        requireApproval:          rr.approvalMode === 'manual',
        requireLogin:             rr.requireLogin,
        allowGuestRegistration:   rr.allowGuestRegistration,
        allowFileUpload:          rr.allowFileUpload,
        oneRegistrationPerEmail:  rr.limitPerEmail,
        oneRegistrationPerMobile: rr.limitPerMobile,
      }
    }
    onChange(next)
  }

  // ── Template application ──────────────────────────────────────────────────────

  // Build template sections (with pass groups applied)
  const buildTemplateSections = (t: FormTemplateConfig): FormSection[] => {
    if (t.sections) {
      return applyPassGroupsToSections(t.sections(), t.passGroups, passes)
    }
    return migrateFieldsToSections(applyPassGroups(t.fields(), t.passGroups, passes))
  }

  // Full replace: new sections, new fields, reset conditional rules
  const applyTemplate = (t: FormTemplateConfig) => {
    update({ template: t.id, sections: buildTemplateSections(t), conditionalRules: t.defaultRules })
    setActiveTab('fields')
  }

  // Partial replace: new sections/fields only; keep existing rules + registrationRules
  const applyTemplateFieldsOnly = (t: FormTemplateConfig) => {
    update({ template: t.id, sections: buildTemplateSections(t) })
    setActiveTab('fields')
  }

  // Gate: show confirmation if the form already has content (even for the same template,
  // so re-clicking an active template card doesn't silently overwrite customisations).
  const requestApplyTemplate = (t: FormTemplateConfig) => {
    const hasContent =
      form.sections.some(s => s.fields.length > 0) || form.conditionalRules.length > 0
    if (hasContent) {
      setConfirmingTemplate(t)
    } else {
      applyTemplate(t)
    }
  }

  // ── Section management ────────────────────────────────────────────────────────
  const addSection = (title: string) => {
    const s: FormSection = {
      id: makeSectionId(), title, description: '', order: form.sections.length, fields: [],
    }
    update({ sections: [...form.sections, s] })
  }

  const renameSection = (id: string, title: string) =>
    update({ sections: form.sections.map(s => s.id === id ? { ...s, title } : s) })

  const deleteSection = (id: string) =>
    update({ sections: form.sections.filter(s => s.id !== id) })

  const duplicateSection = (id: string) => {
    const src = form.sections.find(s => s.id === id)
    if (!src) return
    const copy: FormSection = {
      ...src,
      id:     makeSectionId(),
      title:  `${src.title} (Copy)`,
      fields: src.fields.map(f => ({ ...f, id: makeFieldId(), options: [...f.options] })),
    }
    const idx  = form.sections.findIndex(s => s.id === id)
    const next = [...form.sections]
    next.splice(idx + 1, 0, copy)
    update({ sections: next })
  }

  const moveSection = (id: string, dir: 'up' | 'down') => {
    const idx = form.sections.findIndex(s => s.id === id)
    if (dir === 'up' && idx === 0) return
    if (dir === 'down' && idx === form.sections.length - 1) return
    const next = [...form.sections]
    const swap = dir === 'up' ? idx - 1 : idx + 1
    ;[next[idx], next[swap]] = [next[swap]!, next[idx]!]
    update({ sections: next })
  }

  // ── Field management (section-aware) ─────────────────────────────────────────
  const openAddField = (sectionId: string) => {
    setEditingField(makeBlankField())
    setEditingSectionId(sectionId)
    setIsNewField(true)
  }

  const openEditField = (field: FormField, sectionId: string) => {
    setEditingField({ ...field, options: [...field.options] })
    setEditingSectionId(sectionId)
    setIsNewField(false)
  }

  const saveField = (field: FormField, targetSectionId?: string) => {
    const srcId = editingSectionId
    const dstId = targetSectionId ?? srcId

    // Ensure field ID is unique across the entire form before inserting
    const allIds = new Set(form.fields.map(f => f.id))
    const safeField = isNewField && allIds.has(field.id)
      ? { ...field, id: makeFieldId() }
      : field

    if (isNewField) {
      update({
        sections: form.sections.map(s =>
          s.id === dstId ? { ...s, fields: [...s.fields, safeField] } : s,
        ),
      })
    } else if (dstId && dstId !== srcId) {
      // Cross-section move — use safeField (same ID, no new-field path here)
      update({
        sections: form.sections.map(s => {
          if (s.id === srcId) return { ...s, fields: s.fields.filter(f => f.id !== safeField.id) }
          if (s.id === dstId) return { ...s, fields: [...s.fields, safeField] }
          return s
        }),
      })
    } else {
      update({
        sections: form.sections.map(s =>
          s.id === srcId
            ? { ...s, fields: s.fields.map(f => f.id === safeField.id ? safeField : f) }
            : s,
        ),
      })
    }
    setEditingField(null)
    setEditingSectionId(null)
  }

  const deleteField = (fieldId: string, sectionId: string) =>
    update({
      sections: form.sections.map(s =>
        s.id === sectionId ? { ...s, fields: s.fields.filter(f => f.id !== fieldId) } : s,
      ),
    })

  const duplicateField = (field: FormField, sectionId: string) =>
    update({
      sections: form.sections.map(s =>
        s.id === sectionId
          ? { ...s, fields: [...s.fields, { ...field, id: makeFieldId(), label: `${field.label} (Copy)`, options: [...field.options] }] }
          : s,
      ),
    })

  const moveField = (fieldId: string, sectionId: string, dir: 'up' | 'down') =>
    update({
      sections: form.sections.map(s => {
        if (s.id !== sectionId) return s
        const idx = s.fields.findIndex(f => f.id === fieldId)
        if (dir === 'up' && idx === 0) return s
        if (dir === 'down' && idx === s.fields.length - 1) return s
        const next = [...s.fields]
        const swap = dir === 'up' ? idx - 1 : idx + 1
        ;[next[idx], next[swap]] = [next[swap]!, next[idx]!]
        return { ...s, fields: next }
      }),
    })

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[1fr_260px]">

      {/* ── Left: builder ── */}
      <div className="flex min-w-0 flex-col gap-4">

        {/* Tab strip */}
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div className="flex overflow-x-auto border-b border-border/70">
            {TABS.map(tab => {
              const Icon = tab.icon
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-4 py-2.5 text-[12px] font-medium transition-colors',
                    activeTab === tab.id
                      ? 'border-primary text-primary'
                      : 'border-transparent text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon className="size-3.5" aria-hidden />
                  {tab.label}
                  {tab.id === 'fields' && form.sections.length > 0 && (
                    <span className="rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-bold text-primary">
                      {form.sections.length}
                    </span>
                  )}
                  {tab.id === 'logic' && form.conditionalRules.length > 0 && (
                    <span className="rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-bold text-primary">
                      {form.conditionalRules.length}
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          {/* Tab content */}
          <div className="p-4">
            {activeTab === 'template' && (
              <TemplateTab
                templates={templates}
                selectedId={form.template}
                onApply={requestApplyTemplate}
              />
            )}
            {activeTab === 'fields' && (
              <FieldsTab
                sections={form.sections}
                onAddSection={addSection}
                onRenameSection={renameSection}
                onDeleteSection={deleteSection}
                onDuplicateSection={duplicateSection}
                onMoveSection={moveSection}
                onAddField={openAddField}
                onEditField={openEditField}
                onDeleteField={deleteField}
                onDuplicateField={duplicateField}
                onMoveField={moveField}
              />
            )}
            {activeTab === 'settings' && (
              <SettingsTab
                rules={form.registrationRules}
                onChange={r => update({ registrationRules: r })}
                syncedApprovalMode={syncedApprovalMode}
                approvalModeSource={approvalModeSource}
                onApprovalModeSourceChange={src => {
                  setApprovalModeSource(src)
                  if (src === 'synced' && syncedApprovalMode != null) {
                    update({ registrationRules: { ...form.registrationRules, approvalMode: syncedApprovalMode } })
                  }
                }}
              />
            )}
            {activeTab === 'logic' && (
              <LogicTab
                fields={form.fields}
                rules={form.conditionalRules}
                onChange={r => update({ conditionalRules: r })}
              />
            )}
          </div>
        </div>
      </div>

      {/* ── Right: summary panel ── */}
      <div className="lg:sticky lg:top-4">
        <FormSummaryPanel
          form={form}
          templates={templates}
          passes={passes}
          onPreview={() => setPreviewOpen(true)}
        />
      </div>

      {/* Field edit modal */}
      <AnimatePresence>
        {editingField && (
          <FieldEditModal
            field={editingField}
            isNew={isNewField}
            onSave={saveField}
            onCancel={() => { setEditingField(null); setEditingSectionId(null) }}
            passes={passes}
            sectionId={editingSectionId ?? undefined}
            sections={form.sections.map(s => ({ id: s.id, title: s.title }))}
          />
        )}
      </AnimatePresence>

      {/* Form preview modal */}
      <AnimatePresence>
        {previewOpen && (
          <FormPreviewModal
            form={form}
            passes={passes}
            onClose={() => setPreviewOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* Template replace confirmation */}
      <AnimatePresence>
        {confirmingTemplate && (
          <TemplateReplaceModal
            template={confirmingTemplate}
            sectionsCount={form.sections.length}
            fieldsCount={form.fields.length}
            rulesCount={form.conditionalRules.length}
            onReplaceAll={() => { applyTemplate(confirmingTemplate); setConfirmingTemplate(null) }}
            onReplaceFieldsOnly={() => { applyTemplateFieldsOnly(confirmingTemplate); setConfirmingTemplate(null) }}
            onCancel={() => setConfirmingTemplate(null)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
