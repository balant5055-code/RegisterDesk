'use client'
import { useCallback, useEffect, useState } from 'react'

type Theme = 'light' | 'dark'

const STORAGE_KEY = 'rd-theme'

export function useTheme() {
  const [theme, setTheme] = useState<Theme>('light')

  useEffect(() => {
    const stored = (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? 'light'
    setTheme(stored)
    document.documentElement.classList.toggle('dark', stored === 'dark')
  }, [])

  const toggle = useCallback(() => {
    setTheme(prev => {
      const next: Theme = prev === 'light' ? 'dark' : 'light'
      localStorage.setItem(STORAGE_KEY, next)
      document.documentElement.classList.toggle('dark', next === 'dark')
      return next
    })
  }, [])

  return { theme, toggle, isDark: theme === 'dark' }
}
