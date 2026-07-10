import { createContext, ReactNode, useCallback, useContext, useMemo, useState } from 'react'

// Registered flags. Adding a new one: append here + the readers get a
// typed `useFlag(name)`. Each entry is a literal-tuple so TS infers the
// value type from `options`.
export const FLAGS = {
  availSrc: {
    // 'v3' = avail-v3 min-cover pyramid via the inventory-driven planner
    // (pyrmts `ffc72db`); ~1.3s chart XHR vs ~3-5s on the legacy
    // 'totals' path. 'totals' remains as the escape hatch
    // (`?availSrc=totals`) until #108 retires the legacy reader.
    default: 'v3' as const,
    options: ['totals', 'v3'] as const,
    description: 'Per-station availability backend',
  },
  api: {
    default: 'prod' as const,
    options: ['prod', 'dev'] as const,
    description: 'gbfs-api worker target',
    devOnly: true,
  },
} as const satisfies Record<string, FlagDef<string>>

interface FlagDef<T extends string> {
  default: T
  options: readonly T[]
  description?: string
  devOnly?: boolean
}

export type FlagName = keyof typeof FLAGS
export type FlagValue<K extends FlagName> = (typeof FLAGS)[K]['options'][number]
export type FlagSource = 'url' | 'localStorage' | 'default'

type FlagsState = { [K in FlagName]: FlagValue<K> }
type FlagsSources = { [K in FlagName]: FlagSource }

interface FlagsContextType {
  flags: FlagsState
  sources: FlagsSources
  setFlag: <K extends FlagName>(name: K, value: FlagValue<K>) => void
  resetFlag: (name: FlagName) => void
}

const FlagsContext = createContext<FlagsContextType | undefined>(undefined)

const LS_PREFIX = 'ctbk:flag:'
const URL_PREFIX = 'flag.'

// Back-compat: bare URL params like `?availSrc=v3` still honored. Drop
// after panel-driven workflow is well-established.
const BARE_URL_BACK_COMPAT: FlagName[] = ['availSrc', 'api']

function isDevHost(): boolean {
  if (typeof window === 'undefined') return false
  const h = window.location.hostname
  return h === 'localhost'
    || h === '127.0.0.1'
    || h.endsWith('.tail.scale.ts.net')
    || h.endsWith('.tailnet.ts.net')
}

function readUrl(name: FlagName, params: URLSearchParams): string | null {
  const prefixed = params.get(`${URL_PREFIX}${name}`)
  if (prefixed !== null) return prefixed
  if (BARE_URL_BACK_COMPAT.includes(name)) {
    return params.get(name)
  }
  return null
}

function readLs(name: FlagName): string | null {
  try {
    return localStorage.getItem(`${LS_PREFIX}${name}`)
  } catch {
    return null
  }
}

function isValid<K extends FlagName>(name: K, raw: string): raw is FlagValue<K> {
  return (FLAGS[name].options as readonly string[]).includes(raw)
}

function resolveFlag<K extends FlagName>(
  name: K,
  params: URLSearchParams,
  devMode: boolean,
): { value: FlagValue<K>; source: FlagSource } {
  const def = FLAGS[name]
  if ('devOnly' in def && def.devOnly && !devMode) {
    return { value: def.default as FlagValue<K>, source: 'default' }
  }
  const urlRaw = readUrl(name, params)
  if (urlRaw !== null && isValid(name, urlRaw)) {
    return { value: urlRaw, source: 'url' }
  }
  const lsRaw = readLs(name)
  if (lsRaw !== null && isValid(name, lsRaw)) {
    return { value: lsRaw, source: 'localStorage' }
  }
  return { value: def.default as FlagValue<K>, source: 'default' }
}

export function FlagsProvider({ children }: { children: ReactNode }) {
  const devMode = useMemo(() => isDevHost(), [])

  const [{ flags, sources }, setState] = useState<{
    flags: FlagsState
    sources: FlagsSources
  }>(() => {
    const params = new URLSearchParams(window.location.search)
    const flags = {} as FlagsState
    const sources = {} as FlagsSources
    for (const name of Object.keys(FLAGS) as FlagName[]) {
      const { value, source } = resolveFlag(name, params, devMode)
      ;(flags as Record<FlagName, string>)[name] = value
      sources[name] = source
    }
    return { flags, sources }
  })

  const setFlag = useCallback(<K extends FlagName>(name: K, value: FlagValue<K>) => {
    try {
      localStorage.setItem(`${LS_PREFIX}${name}`, value)
    } catch { /* private mode etc — fall through to state-only */ }
    setState((prev) => ({
      flags: { ...prev.flags, [name]: value },
      sources: { ...prev.sources, [name]: 'localStorage' as FlagSource },
    }))
  }, [])

  const resetFlag = useCallback((name: FlagName) => {
    try {
      localStorage.removeItem(`${LS_PREFIX}${name}`)
    } catch { /* ignore */ }
    const params = new URLSearchParams(window.location.search)
    const { value, source } = resolveFlag(name, params, devMode)
    setState((prev) => ({
      flags: { ...prev.flags, [name]: value },
      sources: { ...prev.sources, [name]: source },
    }))
  }, [devMode])

  const value = useMemo(
    () => ({ flags, sources, setFlag, resetFlag }),
    [flags, sources, setFlag, resetFlag],
  )

  return <FlagsContext.Provider value={value}>{children}</FlagsContext.Provider>
}

export function useFlag<K extends FlagName>(name: K): FlagValue<K> {
  const ctx = useContext(FlagsContext)
  if (!ctx) throw new Error('useFlag must be used within a FlagsProvider')
  return ctx.flags[name]
}

export function useFlagsController(): FlagsContextType {
  const ctx = useContext(FlagsContext)
  if (!ctx) throw new Error('useFlagsController must be used within a FlagsProvider')
  return ctx
}

export function isFlagVisible(name: FlagName): boolean {
  const def = FLAGS[name]
  return !('devOnly' in def && def.devOnly && !isDevHost())
}
