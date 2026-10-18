import { describe, expect, it } from 'vitest'
import {
  getReferenceMode,
  MULTITRACK_REFERENCE_MODES,
  nextReferenceMode,
  referenceModePatch,
} from '@/lib/multitrack-utils'

describe('reference scope helpers', () => {
  it('migrates legacy flags', () => {
    expect(getReferenceMode({})).toBe('off')
    expect(getReferenceMode({ reference_mode: 'global' })).toBe('global')
    expect(getReferenceMode({ shared_reference: true })).toBe('aligned')
    expect(getReferenceMode({ shared_reference: true, reference_scope: 'full' })).toBe('global')
    expect(getReferenceMode({ speaker_reference: true })).toBe('aligned')
    // 新字段优先
    expect(getReferenceMode({ reference_mode: 'off', shared_reference: true })).toBe('off')
  })

  it('cycles off -> aligned -> global -> off', () => {
    expect(nextReferenceMode('off')).toBe('aligned')
    expect(nextReferenceMode('aligned')).toBe('global')
    expect(nextReferenceMode('global')).toBe('off')
    expect(MULTITRACK_REFERENCE_MODES).toEqual(['off', 'aligned', 'global'])
  })

  it('writes canonical mode while keeping legacy fields in sync', () => {
    expect(referenceModePatch('aligned')).toMatchObject({
      reference_mode: 'aligned',
      shared_reference: true,
      reference_scope: 'window',
    })
    expect(referenceModePatch('global')).toMatchObject({
      reference_mode: 'global',
      shared_reference: true,
      reference_scope: 'full',
    })
    expect(referenceModePatch('off')).toMatchObject({
      reference_mode: 'off',
      shared_reference: false,
      reference_scope: 'window',
    })
  })
})
