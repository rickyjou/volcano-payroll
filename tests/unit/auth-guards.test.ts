import { describe, expect, it } from 'vitest';
import { assertEmailConfirmed } from '../../src/server/auth';
import { HttpError } from '../../src/server/http';

describe('assertEmailConfirmed', () => {
  it('lets confirmed users through', () => {
    expect(() => assertEmailConfirmed({ email_confirmed: true }, false)).not.toThrow();
  });
  it('blocks unconfirmed or unknown confirmation state', () => {
    for (const user of [{ email_confirmed: false }, {}]) {
      try {
        assertEmailConfirmed(user, false);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(HttpError);
        expect((e as HttpError).code).toBe('EMAIL_NOT_CONFIRMED');
      }
    }
  });
  it('can be relaxed for local development', () => {
    expect(() => assertEmailConfirmed({ email_confirmed: false }, true)).not.toThrow();
  });
});
