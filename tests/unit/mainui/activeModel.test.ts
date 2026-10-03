import { describe, expect, it } from 'vitest'
import { BUILTIN_MODES } from '@shared/builtinModes'
import { DEFAULT_SETTINGS } from '@shared/settings'
import type { Mode } from '@shared/types'
import { activeMode, answeringModel } from '@renderer/main/lib/activeModel'

const models = DEFAULT_SETTINGS.models
const plain: Mode = { ...BUILTIN_MODES[0]!, id: 'plain', modelOverrides: {} }
const sales: Mode = {
  ...BUILTIN_MODES[0]!,
  id: 'sales',
  modelOverrides: { smart: 'anthropic/claude-sonnet-4.5', fast: 'openai/gpt-5-mini' },
}

describe('answeringModel (header subtitle)', () => {
  it('names the Smart model by default', () => {
    expect(answeringModel({ ...models, activeTier: 'smart' }, plain)).toBe(models.smart.model)
  })

  it('follows the overlay Fast/Smart tier', () => {
    const fast = { ...models, activeTier: 'fast' as const }
    expect(answeringModel(fast, plain)).toBe(models.fast.model)
    expect(models.fast.model).not.toBe(models.smart.model)
  })

  it("uses the active Mode's override for the active tier", () => {
    expect(answeringModel({ ...models, activeTier: 'smart' }, sales)).toBe(
      'anthropic/claude-sonnet-4.5',
    )
    expect(answeringModel({ ...models, activeTier: 'fast' }, sales)).toBe('openai/gpt-5-mini')
  })

  it('ignores an empty override', () => {
    const empty: Mode = { ...plain, modelOverrides: { smart: '' } }
    expect(answeringModel({ ...models, activeTier: 'smart' }, empty)).toBe(models.smart.model)
  })
})

describe('activeMode', () => {
  it('finds the active Mode, else General, else the first', () => {
    const general: Mode = { ...plain, id: 'builtin-general' }
    expect(activeMode([plain, sales], 'sales')).toBe(sales)
    expect(activeMode([plain, general], 'gone')).toBe(general)
    expect(activeMode([plain, sales], 'gone')).toBe(plain)
    expect(activeMode([], 'gone')).toBeUndefined()
  })
})
