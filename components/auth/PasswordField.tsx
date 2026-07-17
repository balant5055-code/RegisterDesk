'use client'

import { useState } from 'react'
import { Eye, EyeOff, Lock } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { AuthField } from './AuthField'

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
}

export function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  placeholder,
  Icon = Lock,
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
