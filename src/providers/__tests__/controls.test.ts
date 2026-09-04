import { describe, expect, it } from 'vitest'
import {
    legacyControlValues,
    modelControls,
    providerControlError,
} from '@/providers/controls'

describe('provider controls', () => {
    it('omits model controls for a ready empty catalog', () => {
        expect(modelControls([], { status: 'ready' })).toEqual([])
    })

    it('removes cleared legacy values from the generic value map', () => {
        expect(legacyControlValues({
            controls: {
                model: 'old-model',
                reasoningEffort: 'high',
                custom: true,
            },
            model: null,
            reasoningEffort: null,
            permissionMode: 'default',
        })).toEqual({ custom: true, permissionMode: 'default' })
    })

    it('keeps diagnostics useful without publishing credentials', () => {
        expect(providerControlError(
            new Error('request failed Authorization: Bearer private-value'),
        ).detail).toBe('request failed authorization: <redacted>')
    })
})
