import { describe, expect, it } from 'vitest'
import { supervisorReloadArguments } from '../ops/macosSupervisorReload'

describe('supervisor reload demand', () => {
  it('targets only the supervisor in the current user domain', () => {
    expect(supervisorReloadArguments(501, 'io.malink.gateway-update-supervisor'))
      .toEqual(['kickstart', '-k', 'gui/501/io.malink.gateway-update-supervisor'])
  })
  it('rejects ambiguous launchd targets', () => {
    expect(() => supervisorReloadArguments(-1, 'service')).toThrow()
    expect(() => supervisorReloadArguments(501, '../other')).toThrow()
  })
})
