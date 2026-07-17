import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// LS2.1B — Teach tailwind-merge about the project's custom font-size utilities
// (text-fs-*, generated from the --fs-* design tokens via @theme in globals.css).
// Without this, twMerge lumps `text-fs-*` into the same ambiguous `text-*` bucket
// as text colors and DROPS the font-size whenever a color class is present in the
// same cn() call — silently losing the size. Registering them under the font-size
// group makes a typography role and a text-color class coexist, while still
// resolving conflicts *within* font-size (text-fs-md text-fs-lg → text-fs-lg).
const FONT_SIZE_UTILITIES = [
  'fs-2xs', 'fs-xs', 'fs-sm', 'fs-base', 'fs-md', 'fs-lg', 'fs-xl',
  'fs-2xl', 'fs-3xl', 'fs-4xl', 'fs-5xl',
  'fs-display-sm', 'fs-display-md', 'fs-display-lg',
]

const twMerge = extendTailwindMerge({
  extend: { classGroups: { 'font-size': [{ text: FONT_SIZE_UTILITIES }] } },
})

/**
 * Merges Tailwind classes safely.
 * clsx handles conditionals/arrays; twMerge resolves conflicting utilities
 * (e.g. "px-4 px-6" → "px-6" instead of both being emitted).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
