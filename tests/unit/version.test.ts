import { describe, expect, it } from 'vitest';
import { versionInfo } from '../../src/server/version';

describe('versionInfo', () => {
  it('reports the commit filled in by git archive', () => {
    expect(versionInfo('40ed3ce0', '2026-10-09T12:00:00-07:00')).toEqual({
      commit: '40ed3ce0',
      committedAt: '2026-10-09T12:00:00-07:00',
    });
  });

  it('reports null outside a git archive', () => {
    expect(versionInfo('$Format:%H$', '$Format:%cI$')).toEqual({ commit: null, committedAt: null });
  });
});
