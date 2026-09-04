import { describe, expect, it } from 'vitest'
import { acpSessionControls } from '../sessionControls'

describe('ACP session provider controls', () => {
    it('maps models and arbitrary ACP config options to active-session controls', () => {
        const controls = acpSessionControls(
            {
                currentModelId: 'model-a',
                availableModels: [
                    { modelId: 'model-a', name: 'Model A', description: 'Fast' },
                ],
            },
            [{
                id: 'planMode',
                name: 'Plan mode',
                description: 'Plan before editing',
                type: 'boolean',
                currentValue: true,
            }, {
                id: 'verbosity',
                name: 'Verbosity',
                type: 'select',
                currentValue: 'concise',
                options: [
                    { value: 'concise', name: 'Concise' },
                    { value: 'detailed', name: 'Detailed' },
                ],
            }],
        )

        expect(controls).toMatchObject([
            { id: 'model', surfaces: ['session-active'], value: 'model-a' },
            { id: 'planMode', renderer: 'toggle', value: true },
            { id: 'verbosity', renderer: 'segmented', value: 'concise' },
        ])
    })

    it('normalizes ACP thought-level configuration without inventing unsupported controls', () => {
        const controls = acpSessionControls(null, [{
            id: 'thinking',
            category: 'thought_level',
            name: 'Thinking',
            type: 'select',
            currentValue: 'high',
            options: [{ value: 'high', name: 'High' }],
        }])
        expect(controls.map(control => control.id)).toEqual(['reasoningEffort'])
        expect(acpSessionControls(null, [])).toEqual([])
    })
})
