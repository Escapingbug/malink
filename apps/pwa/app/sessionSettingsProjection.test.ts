import { describe, expect, it } from 'vitest';
import { sessionSettingsProjected } from './sessionSettingsProjection';

describe('confirmed session setting projection', () => {
  it('keeps the selection across a command acknowledgement followed by stale snapshots', () => {
    const update = { changes: { model: 'new' }, cleared: [] };
    expect(sessionSettingsProjected(update, { model: 'old' })).toBe(false);
    expect(sessionSettingsProjected(update, { model: 'old', controlValues: { model: 'new' } })).toBe(false);
    expect(sessionSettingsProjected(update, { model: 'new', controlValues: { model: 'new' } })).toBe(true);
  });
  it('waits for cleared legacy and generic controls to converge', () => {
    const update = { changes: {}, cleared: ['model'] };
    expect(sessionSettingsProjected(update, { model: 'old' })).toBe(false);
    expect(sessionSettingsProjected(update, { controlValues: { model: 'old' } })).toBe(false);
    expect(sessionSettingsProjected(update, {})).toBe(true);
  });
});
