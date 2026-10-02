import { en } from './en'

export type Locale = 'en'
export type Messages = typeof en

type Join<K, P> = K extends string ? (P extends string ? `${K}.${P}` : never) : never
type Leaves<T, D extends number = 5> = [D] extends [never]
  ? never
  : T extends string
    ? ''
    : {
        [K in keyof T]-?: T[K] extends string ? K & string : Join<K, Leaves<T[K], Prev[D]>>
      }[keyof T]
type Prev = [never, 0, 1, 2, 3, 4, 5]

export type MessageKey = Leaves<Messages>

const catalogs: Record<Locale, unknown> = { en }
let currentLocale: Locale = 'en'

export function setLocale(locale: Locale): void {
  currentLocale = locale
}

function lookup(catalog: unknown, key: string): string | undefined {
  let node: unknown = catalog
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string' ? node : undefined
}

/**
 * Translates a message key. `{name}` placeholders are replaced from `vars`.
 * Falls back to English, then to the key itself.
 */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const raw = lookup(catalogs[currentLocale], key) ?? lookup(en, key) ?? key
  if (!vars) return raw
  return raw.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m))
}
