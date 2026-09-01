import { describe, expect, it } from 'vitest'
import {
  providerHistoryPage,
  splitProviderHistoryMessage,
} from '@/gateway/matrix/providerHistoryMaterialization'

const original = [
  { id: 'm1', role: 'user' as const, text: 'first' },
  { id: 'm2', role: 'assistant' as const, text: 'second' },
  { id: 'm3', role: 'user' as const, text: 'third' },
]

describe('Provider History materialization', () => {
  it('freezes reverse pages without re-reading or shifting their frontier', () => {
    expect(providerHistoryPage(original, 0, 2)).toEqual([
      { message: original[2], sourceOrdinal: 2 },
      { message: original[1], sourceOrdinal: 1 },
    ])
    expect(providerHistoryPage(original, 2, 2)).toEqual([
      { message: original[0], sourceOrdinal: 0 },
    ])
  })

  it('chunks oversized messages while preserving every character', () => {
    const input = '历史'.repeat(20_000)
    const parts = splitProviderHistoryMessage(input)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.join('')).toBe(input)
  })
})
