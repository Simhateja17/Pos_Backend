import { describe, expect, it } from 'vitest'
import { pinSessionRequiresTerminal } from '../../src/lib/pinSessionPolicy'

describe('PIN session pairing policy', () => {
  it('blocks cashier/register work until the browser resolves to a counter', () => {
    expect(pinSessionRequiresTerminal('register')).toBe(true)
    expect(pinSessionRequiresTerminal('approval')).toBe(true)
  })

  it('allows owner or manager authentication before pairing', () => {
    expect(pinSessionRequiresTerminal('management')).toBe(false)
  })
})
