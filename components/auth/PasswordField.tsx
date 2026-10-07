'use client'

import { useState } from 'react'
import { Eye, EyeOff, Lock } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { AuthField, type AuthFieldAccent, type AuthFieldVariant, type AuthFieldRadius } from './AuthField'

// ─── PasswordField ──────────────────────────────────────────────────────────
// AuthField specialised for passwords: owns its own show/hide state and renders
// the eye toggle as the trailing suffix. Controlled value/onChange. Defaults to
// the Lock leading icon.

export interface PasswordFieldProps {
  id:            string
  label:         string
  value:         string
  onChange:      (v: string) => void
  autoComplete?: string
  placeholder?:  string
  Icon?:         LucideIcon
  /** Forwarded to AuthField. Defaults to the organizer accent, as it always did. */
  accent?:       AuthFieldAccent
  /** Forwarded to AuthField. Defaults to the bordered control, as it always did. */
  variant?:      AuthFieldVariant
  /** Forwarded to AuthField. Defaults to drawing the icon, as it always did. */
  hideIcon?:     boolean
  /** Forwarded to AuthField. Defaults to the 12px radius, as it always did. */
  radius?:       AuthFieldRadius
}

export function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  placeholder,
  Icon = Lock,
  accent = 'primary',
  variant = 'box',
  hideIcon = false,
  radius = 'lg',
}: PasswordFieldProps) {
  const [visible, setVisible] = useState(false)

  return (
    <AuthField
      id={id}
      label={label}
      type={visible ? 'text' : 'password'}
      placeholder={placeholder}
      value={value}
      onChange={onChange}
      autoComplete={autoComplete}
      Icon={Icon}
      accent={accent}
      variant={variant}
      hideIcon={hideIcon}
      radius={radius}
      suffix={
        <button
          type="button"
          aria-label={visible ? 'Hide password' : 'Show password'}
          onClick={() => setVisible((v) => !v)}
          className="cursor-pointer text-muted-foreground transition-colors duration-150 hover:text-foreground"
        >
          {visible ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
        </button>
      }
    />
  )
}
