import { createContext, useContext, useEffect, useState, useCallback } from 'react'

export type Theme = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'manhwa-studio-theme'

interface ThemeContextValue {
  /** The user's choice, including 'system'. */
  theme: Theme
  /** The theme actually painted right now — 'system' resolved against the OS. */
  resolvedTheme: 'light' | 'dark'
  setTheme: (theme: Theme) => void
  /** Flip between light and dark, resolving 'system' first. */
  toggleTheme: () => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function prefersDark() {
  return typeof window !== 'undefined'
    && window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch {
    // localStorage can throw in private mode / when site data is blocked
  }
  return 'dark'
}

function resolve(theme: Theme): 'light' | 'dark' {
  return theme === 'system' ? (prefersDark() ? 'dark' : 'light') : theme
}

/** Apply the theme to <html> so Tailwind's `dark:` variants and CSS vars switch. */
function applyTheme(resolved: 'light' | 'dark') {
  const root = document.documentElement
  root.classList.toggle('dark', resolved === 'dark')
  root.style.colorScheme = resolved
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme)
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() => resolve(readStoredTheme()))

  // Paint whenever the choice changes, and follow the OS while on 'system'.
  useEffect(() => {
    const sync = () => {
      const next = resolve(theme)
      setResolvedTheme(next)
      applyTheme(next)
    }
    sync()

    if (theme !== 'system') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [theme])

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Non-fatal: the theme still applies for this session.
    }
  }, [])

  const toggleTheme = useCallback(() => {
    setTheme(resolve(theme) === 'dark' ? 'light' : 'dark')
  }, [theme, setTheme])

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider')
  return ctx
}
