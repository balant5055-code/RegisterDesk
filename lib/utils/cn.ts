import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merges Tailwind classes safely.
 * clsx handles conditionals/arrays; twMerge resolves conflicting utilities
 * (e.g. "px-4 px-6" → "px-6" instead of both being emitted).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
