// Short-term Amazon Bedrock API keys, renewed automatically. A key is a SigV4-presigned
// token made from AWS credentials, valid for 12 hours or until those credentials expire,
// whichever is first, and only in the Region it was made for. Keeping a cached key and
// signing a new one shortly before it lapses means no key ever has to be rotated by hand.
import { getToken } from '@aws/bedrock-token-generator';

export interface Credentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string; expiration?: Date }

export interface TokenSource {
  /** A valid key; `renew` signs a new one even if the cached one looks valid (after a 401/403). */
  token(opts?: { renew?: boolean }): Promise<string>;
}

interface Options {
  region: string;
  credentials: () => Promise<Credentials>;
  sign?: (c: { credentials: Credentials; region: string; expiresInSeconds: number }) => Promise<string>;
  now?: () => number;
}

const MAX_LIFETIME_S = 12 * 3600;
/** Renew this long before expiry, so a key never lapses in the middle of a turn. */
const MARGIN_MS = 5 * 60_000;

export class BedrockTokenSource implements TokenSource {
  private cached: { token: string; renewAt: number } | null = null;
  private pending: Promise<string> | null = null;

  constructor(private readonly opts: Options) {}

  token(opts: { renew?: boolean } = {}): Promise<string> {
    const now = (this.opts.now ?? Date.now)();
    if (!opts.renew && this.cached && now < this.cached.renewAt) return Promise.resolve(this.cached.token);
    // Concurrent turns share one signing; a failed one isn't kept.
    this.pending ??= this.sign(now).finally(() => (this.pending = null));
    return this.pending;
  }

  private async sign(now: number): Promise<string> {
    const credentials = await this.opts.credentials();
    const credsLeft = credentials.expiration ? Math.floor((credentials.expiration.getTime() - now) / 1000) : Infinity;
    const expiresInSeconds = Math.max(1, Math.min(MAX_LIFETIME_S, credsLeft));
    const token = await (this.opts.sign ?? getToken)({ credentials, region: this.opts.region, expiresInSeconds });
    this.cached = { token, renewAt: now + expiresInSeconds * 1000 - MARGIN_MS };
    return token;
  }
}

/** The Region of a Bedrock runtime URL (whose keys are Region-specific), or null for any other host. */
export function bedrockRegion(url: string): string | null {
  try {
    return /^bedrock-runtime\.([a-z0-9-]+)\.amazonaws\.com$/.exec(new URL(url).hostname)?.[1] ?? null;
  } catch {
    return null;
  }
}

// One source per Region and key, kept across requests (the agent config is built per request).
const sources = new Map<string, BedrockTokenSource>();

/**
 * Signs with BEDROCK_ACCESS_KEY_ID / BEDROCK_SECRET_ACCESS_KEY when set (the cloud), else with
 * the default AWS credential chain, e.g. a developer's `aws login` session (local).
 */
export function bedrockTokenSource(region: string, env: Record<string, string | undefined>): TokenSource {
  const id = env.BEDROCK_ACCESS_KEY_ID;
  const secret = env.BEDROCK_SECRET_ACCESS_KEY;
  const key = `${region}|${id ?? 'default chain'}`;
  let source = sources.get(key);
  if (!source) {
    const credentials = id && secret
      ? async () => ({ accessKeyId: id, secretAccessKey: secret })
      : async () => (await import('@aws-sdk/credential-provider-node')).defaultProvider()();
    source = new BedrockTokenSource({ region, credentials });
    sources.set(key, source);
  }
  return source;
}
