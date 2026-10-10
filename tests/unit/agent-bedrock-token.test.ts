import { describe, expect, it } from 'vitest';
import { bedrockRegion, BedrockTokenSource, type Credentials } from '../../src/agent/bedrock-token';

const HOUR = 3_600_000;

function fakes(creds: Credentials) {
  let clock = 0;
  const signed: { region: string; expiresInSeconds: number }[] = [];
  const source = new BedrockTokenSource({
    region: 'us-east-2',
    credentials: async () => creds,
    sign: async ({ region, expiresInSeconds }) => {
      signed.push({ region, expiresInSeconds });
      return `token-${signed.length}`;
    },
    now: () => clock,
  });
  return { source, signed, tick: (ms: number) => (clock += ms) };
}

describe('BedrockTokenSource', () => {
  it('reuses a token until shortly before it expires, then signs a new one', async () => {
    const f = fakes({ accessKeyId: 'AK', secretAccessKey: 's' });
    expect(await f.source.token()).toBe('token-1');
    f.tick(11 * HOUR);
    expect(await f.source.token()).toBe('token-1');
    f.tick(HOUR - 4 * 60_000);
    expect(await f.source.token()).toBe('token-2');
    expect(f.signed[0]).toEqual({ region: 'us-east-2', expiresInSeconds: 12 * 3600 });
  });

  it('renews before the signing credentials expire, since the token dies with them', async () => {
    const f = fakes({ accessKeyId: 'ASIA', secretAccessKey: 's', sessionToken: 't', expiration: new Date(HOUR) });
    await f.source.token();
    expect(f.signed[0].expiresInSeconds).toBe(3600);
    f.tick(HOUR - 6 * 60_000);
    expect(await f.source.token()).toBe('token-1');
    f.tick(2 * 60_000);
    expect(await f.source.token()).toBe('token-2');
  });

  it('signs once for concurrent callers and again when asked to renew', async () => {
    const f = fakes({ accessKeyId: 'AK', secretAccessKey: 's' });
    expect(await Promise.all([f.source.token(), f.source.token()])).toEqual(['token-1', 'token-1']);
    expect(await f.source.token({ renew: true })).toBe('token-2');
  });

  it('does not keep a failed signing attempt', async () => {
    let fail = true;
    const source = new BedrockTokenSource({
      region: 'us-east-2',
      credentials: async () => {
        if (fail) throw new Error('no credentials');
        return { accessKeyId: 'AK', secretAccessKey: 's' };
      },
      sign: async () => 'token',
    });
    await expect(source.token()).rejects.toThrow('no credentials');
    fail = false;
    expect(await source.token()).toBe('token');
  });
});

describe('bedrockRegion', () => {
  it("reads the Region from a Bedrock runtime URL and ignores other hosts", () => {
    expect(bedrockRegion('https://bedrock-runtime.us-east-2.amazonaws.com/openai/v1')).toBe('us-east-2');
    expect(bedrockRegion('https://llm.example.com/v1')).toBeNull();
    expect(bedrockRegion('not a url')).toBeNull();
  });
});
