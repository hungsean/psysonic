import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the apiWithCredentials surface — fetchServerFingerprint pulls
// folders / user / license / indexes through it.
vi.mock('@/lib/api/subsonicClient', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api/subsonicClient')>();
  return {
    ...original,
    apiWithCredentials: vi.fn(),
  };
});

import { apiWithCredentials } from '@/lib/api/subsonicClient';
import {
  compareFingerprints,
  fetchServerFingerprint,
  verifySameServerEndpoints,
  type ServerFingerprint,
} from '@/lib/server/serverFingerprint';

function makeFingerprint(overrides: Partial<ServerFingerprint> = {}): ServerFingerprint {
  return {
    ping: {
      type: 'navidrome',
      serverVersion: '0.55.0',
      openSubsonic: true,
      apiVersion: '1.16.1',
    },
    musicFolders: [{ id: '1', name: 'Music' }],
    userId: 'tester',
    licenseKey: 'tester@example.com',
    indexesDigest: 'letters:26|a1,a2',
    ...overrides,
  };
}

// apiWithCredentials resolves to the unwrapped `subsonic-response` body.
function navidromePingResponse() {
  return {
    status: 'ok',
    type: 'navidrome',
    serverVersion: '0.55.0',
    openSubsonic: true,
    version: '1.16.1',
  };
}

function ampachePingResponse() {
  // Minimal Subsonic-shape — ampache doesn't always advertise openSubsonic etc.
  return {
    status: 'ok',
    type: 'ampache',
    serverVersion: '6.0.0',
    version: '1.13.0',
  };
}

type EndpointRoutes = Partial<Record<string, unknown>>;

/**
 * Route apiWithCredentials by base URL + endpoint so parallel probes stay
 * deterministic. A missing endpoint or an `Error` value rejects, like a server
 * that doesn't implement the call.
 */
function routeApi(byUrl: Record<string, EndpointRoutes>) {
  vi.mocked(apiWithCredentials).mockImplementation(async (baseUrl, _u, _p, endpoint) => {
    const value = byUrl[baseUrl]?.[endpoint];
    if (value === undefined) throw new Error('Not implemented');
    if (value instanceof Error) throw value;
    return value;
  });
}

function endpointsCalled(): string[] {
  return vi.mocked(apiWithCredentials).mock.calls.map(call => call[3]);
}

describe('compareFingerprints', () => {
  it('matches two identical fingerprints', () => {
    const a = makeFingerprint();
    const b = makeFingerprint();
    expect(compareFingerprints(a, b)).toBe('match');
  });

  it('mismatches when type differs (case-insensitive)', () => {
    const a = makeFingerprint({ ping: { ...makeFingerprint().ping, type: 'navidrome' } });
    const b = makeFingerprint({ ping: { ...makeFingerprint().ping, type: 'subsonic' } });
    expect(compareFingerprints(a, b)).toBe('mismatch');
  });

  it('mismatches when serverVersion differs', () => {
    const a = makeFingerprint({ ping: { ...makeFingerprint().ping, serverVersion: '0.55.0' } });
    const b = makeFingerprint({ ping: { ...makeFingerprint().ping, serverVersion: '0.54.9' } });
    expect(compareFingerprints(a, b)).toBe('mismatch');
  });

  it('mismatches when openSubsonic differs', () => {
    const a = makeFingerprint({ ping: { ...makeFingerprint().ping, openSubsonic: true } });
    const b = makeFingerprint({ ping: { ...makeFingerprint().ping, openSubsonic: false } });
    expect(compareFingerprints(a, b)).toBe('mismatch');
  });

  it('treats envelope apiVersion as informational (no mismatch on its own)', () => {
    const a = makeFingerprint({ ping: { ...makeFingerprint().ping, apiVersion: '1.16.1' } });
    const b = makeFingerprint({ ping: { ...makeFingerprint().ping, apiVersion: '1.13.0' } });
    expect(compareFingerprints(a, b)).toBe('match');
  });

  it('mismatches when musicFolders differ', () => {
    const a = makeFingerprint({ musicFolders: [{ id: '1', name: 'Music' }] });
    const b = makeFingerprint({ musicFolders: [{ id: '1', name: 'Music' }, { id: '2', name: 'Audiobooks' }] });
    expect(compareFingerprints(a, b)).toBe('mismatch');
  });

  it('treats empty musicFolders on both sides as a matching signal', () => {
    const a = makeFingerprint({ musicFolders: [], userId: null, licenseKey: null, indexesDigest: null });
    const b = makeFingerprint({ musicFolders: [], userId: null, licenseKey: null, indexesDigest: null });
    expect(compareFingerprints(a, b)).toBe('match');
  });

  it('mismatches when userId differs', () => {
    const a = makeFingerprint({ userId: 'tester' });
    const b = makeFingerprint({ userId: 'maria' });
    expect(compareFingerprints(a, b)).toBe('mismatch');
  });

  it('mismatches when licenseKey differs', () => {
    const a = makeFingerprint({ licenseKey: 'a@example.com' });
    const b = makeFingerprint({ licenseKey: 'b@example.com' });
    expect(compareFingerprints(a, b)).toBe('mismatch');
  });

  it('mismatches when indexesDigest differs', () => {
    const a = makeFingerprint({ indexesDigest: 'letters:5|x,y' });
    const b = makeFingerprint({ indexesDigest: 'letters:5|x,z' });
    expect(compareFingerprints(a, b)).toBe('mismatch');
  });

  it('ignores a body signal that is null on one side', () => {
    // userId null on a — only license + folders + indexes contribute; they match.
    const a = makeFingerprint({ userId: null });
    const b = makeFingerprint({ userId: 'tester' });
    expect(compareFingerprints(a, b)).toBe('match');
  });

  it('returns insufficient when ping matches but every body signal is null on at least one side', () => {
    const a = makeFingerprint({
      musicFolders: null,
      userId: null,
      licenseKey: null,
      indexesDigest: null,
    });
    const b = makeFingerprint();
    expect(compareFingerprints(a, b)).toBe('insufficient');
  });
});

describe('fetchServerFingerprint', () => {
  beforeEach(() => {
    vi.mocked(apiWithCredentials).mockReset();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('returns a populated fingerprint for a Navidrome-shaped server', async () => {
    routeApi({
      'https://music.example.com': {
        'ping.view': navidromePingResponse(),
        'getMusicFolders.view': { musicFolders: { musicFolder: [{ id: '1', name: 'Music' }] } },
        'getUser.view': { user: { id: 'tester', username: 'tester' } },
        'getLicense.view': { license: { email: 'tester@example.com' } },
        'getIndexes.view': {
          indexes: {
            index: [
              { name: 'A', artist: [{ id: 'a1' }, { id: 'a2' }] },
              { name: 'B', artist: [{ id: 'b1' }] },
            ],
          },
        },
      },
    });

    const fp = await fetchServerFingerprint('https://music.example.com', 'tester', 'pw');
    expect(fp.ping.type).toBe('navidrome');
    expect(fp.ping.serverVersion).toBe('0.55.0');
    expect(fp.ping.openSubsonic).toBe(true);
    expect(fp.ping.apiVersion).toBe('1.16.1');
    expect(fp.musicFolders).toEqual([{ id: '1', name: 'Music' }]);
    expect(fp.userId).toBe('tester');
    expect(fp.licenseKey).toBe('tester@example.com');
    expect(fp.indexesDigest).toMatch(/^letters:2\|/);
  });

  it('pings through apiWithCredentials with the header profile, never the WebView fetch', async () => {
    // Regression: a WebView `fetch` carrying Cloudflare Access headers sends an
    // OPTIONS preflight the gate rejects, so save reported "Could not reach".
    // apiWithCredentials picks the native transport when gate headers apply.
    const profile = {
      url: 'https://music.example.com',
      alternateUrl: 'http://192.168.0.10:4533',
      customHeaders: [{ name: 'CF-Access-Client-Id', value: 'id' }],
      customHeadersApplyTo: 'public' as const,
    };
    routeApi({ 'https://music.example.com': { 'ping.view': navidromePingResponse() } });

    await fetchServerFingerprint('https://music.example.com', 'tester', 'pw', profile);

    expect(fetch).not.toHaveBeenCalled();
    expect(apiWithCredentials).toHaveBeenCalledWith(
      'https://music.example.com',
      'tester',
      'pw',
      'ping.view',
      {},
      15000,
      profile,
    );
  });

  it('extracts userId only when the server supplies an explicit id (no username fallback)', async () => {
    // Two servers return the same authenticated user but only one of them
    // surfaces a `user.id` — the username-only side must extract null so the
    // comparator skips the signal instead of comparing two unrelated strings.
    routeApi({
      'https://x.example.com': {
        'ping.view': navidromePingResponse(),
        'getMusicFolders.view': { musicFolders: { musicFolder: [] } },
        'getUser.view': { user: { username: 'tester' } }, // no `id` field
        'getLicense.view': {},
        'getIndexes.view': {},
      },
    });
    const fp = await fetchServerFingerprint('https://x.example.com', 'tester', 'pw');
    expect(fp.userId).toBeNull();
  });

  it('handles a partial-fail mix — some optional calls ok, others rejected', async () => {
    // Real-world: a server answers getMusicFolders + getUser but rejects
    // getLicense / getIndexes (subset of OpenSubsonic supported). The
    // fingerprint must surface what succeeded and leave the rest null —
    // guards against a Promise.all-vs-allSettled regression that would
    // collapse the whole fingerprint when one call throws.
    routeApi({
      'https://music.example.com': {
        'ping.view': navidromePingResponse(),
        'getMusicFolders.view': { musicFolders: { musicFolder: [{ id: '1', name: 'Music' }] } },
        'getUser.view': { user: { id: 'tester' } },
        'getLicense.view': new Error('license not implemented'),
        'getIndexes.view': new Error('indexes not implemented'),
      },
    });
    const fp = await fetchServerFingerprint('https://music.example.com', 'tester', 'pw');
    expect(fp.musicFolders).toEqual([{ id: '1', name: 'Music' }]);
    expect(fp.userId).toBe('tester');
    expect(fp.licenseKey).toBeNull();
    expect(fp.indexesDigest).toBeNull();
  });

  it('soft-fails optional calls — minimal Subsonic-shape', async () => {
    // All four optional calls fail (server doesn't support them).
    routeApi({ 'https://ampache.example.com': { 'ping.view': ampachePingResponse() } });

    const fp = await fetchServerFingerprint('https://ampache.example.com', 'u', 'p');
    expect(fp.ping.type).toBe('ampache');
    expect(fp.ping.serverVersion).toBe('6.0.0');
    expect(fp.ping.openSubsonic).toBe(false);
    expect(fp.musicFolders).toBeNull();
    expect(fp.userId).toBeNull();
    expect(fp.licenseKey).toBeNull();
    expect(fp.indexesDigest).toBeNull();
  });

  it('returns a null-bodied fingerprint when ping itself fails', async () => {
    routeApi({ 'https://broken.example.com': { 'ping.view': new Error('HTTP 500') } });
    const fp = await fetchServerFingerprint('https://broken.example.com', 'u', 'p');
    expect(fp.ping.type).toBeNull();
    expect(fp.ping.serverVersion).toBeNull();
    expect(fp.musicFolders).toBeNull();
    expect(fp.userId).toBeNull();
    // Optional calls are skipped entirely once ping fails.
    expect(endpointsCalled()).toEqual(['ping.view']);
  });
});

describe('verifySameServerEndpoints', () => {
  beforeEach(() => {
    vi.mocked(apiWithCredentials).mockReset();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('short-circuits to ok:true for a single-address profile', async () => {
    const result = await verifySameServerEndpoints(
      { url: 'https://music.example.com' },
      'u',
      'p',
    );
    expect(result).toEqual({ ok: true });
    expect(apiWithCredentials).not.toHaveBeenCalled();
  });

  it('returns ok:true when both endpoints fingerprint the same server', async () => {
    // Both pings succeed; both return identical Navidrome payloads.
    const same = {
      'ping.view': navidromePingResponse(),
      'getMusicFolders.view': { musicFolders: { musicFolder: [{ id: '1', name: 'Music' }] } },
    };
    routeApi({ 'https://music.example.com': same, 'http://192.168.0.10': same });

    const result = await verifySameServerEndpoints(
      {
        url: 'https://music.example.com',
        alternateUrl: 'http://192.168.0.10',
      },
      'u',
      'p',
    );
    expect(result).toEqual({ ok: true });
  });

  it('verifies a gate-header profile without touching the WebView fetch', async () => {
    // Public address behind Cloudflare Access + plain LAN address: both pings
    // must go through apiWithCredentials with the full profile so the public
    // one carries its service token over the native transport.
    const same = {
      'ping.view': navidromePingResponse(),
      'getMusicFolders.view': { musicFolders: { musicFolder: [{ id: '1', name: 'Music' }] } },
    };
    routeApi({ 'https://music.example.com': same, 'http://192.168.0.10:4533': same });
    const profile = {
      url: 'https://music.example.com',
      alternateUrl: 'http://192.168.0.10:4533',
      customHeaders: [
        { name: 'CF-Access-Client-Id', value: 'id' },
        { name: 'CF-Access-Client-Secret', value: 'secret' },
      ],
      customHeadersApplyTo: 'public' as const,
    };

    const result = await verifySameServerEndpoints(profile, 'u', 'p');

    expect(result).toEqual({ ok: true });
    expect(fetch).not.toHaveBeenCalled();
    const pingCalls = vi
      .mocked(apiWithCredentials)
      .mock.calls.filter(call => call[3] === 'ping.view');
    expect(pingCalls).toHaveLength(2);
    for (const call of pingCalls) expect(call[6]).toBe(profile);
  });

  it('returns unreachable when one endpoint ping fails', async () => {
    routeApi({
      'https://music.example.com': { 'ping.view': navidromePingResponse() },
      'http://192.168.0.10': { 'ping.view': new Error('HTTP 500') },
    });

    const result = await verifySameServerEndpoints(
      {
        url: 'https://music.example.com',
        alternateUrl: 'http://192.168.0.10',
      },
      'u',
      'p',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unreachable');
      expect(result.unreachableHost).toBe('http://192.168.0.10');
    }
  });

  it('returns mismatch when fingerprints disagree on a body signal', async () => {
    // Two different folder lists.
    const shared = {
      'ping.view': navidromePingResponse(),
      'getUser.view': { user: { id: 'tester' } },
      'getLicense.view': { license: { email: 'a@e.com' } },
      'getIndexes.view': { indexes: { index: [{ name: 'A', artist: [{ id: 'a1' }] }] } },
    };
    routeApi({
      'https://a.example.com': {
        ...shared,
        'getMusicFolders.view': { musicFolders: { musicFolder: [{ id: '1', name: 'Music' }] } },
      },
      'https://b.example.com': {
        ...shared,
        'getMusicFolders.view': { musicFolders: { musicFolder: [{ id: '99', name: 'Other' }] } },
      },
    });

    const result = await verifySameServerEndpoints(
      {
        url: 'https://a.example.com',
        alternateUrl: 'https://b.example.com',
      },
      'u',
      'p',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('mismatch');
  });

  it('returns insufficient when pings agree but no body signal is comparable', async () => {
    // Both servers don't respond to any optional call.
    routeApi({
      'https://ampache-1.example.com': { 'ping.view': ampachePingResponse() },
      'https://ampache-2.example.com': { 'ping.view': ampachePingResponse() },
    });

    const result = await verifySameServerEndpoints(
      {
        url: 'https://ampache-1.example.com',
        alternateUrl: 'https://ampache-2.example.com',
      },
      'u',
      'p',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('insufficient');
  });
});
