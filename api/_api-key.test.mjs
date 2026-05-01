import { strict as assert } from 'node:assert';
import test from 'node:test';
import { validateApiKey } from './_api-key.js';

const VALID_KEY = 'test-valid-key-123';

function makeReq({ origin, referer, secFetchSite, key } = {}) {
  const headers = new Headers();
  if (origin) headers.set('origin', origin);
  if (referer) headers.set('referer', referer);
  if (secFetchSite) headers.set('sec-fetch-site', secFetchSite);
  if (key) headers.set('x-worldmonitor-key', key);
  return new Request('https://api.worldmonitor.app/api/test', { headers });
}

test.before(() => {
  process.env.WORLDMONITOR_VALID_KEYS = VALID_KEY;
});

test('issue #3541 — curl with fake Referer cannot bypass key (no Origin, no Sec-Fetch-Site)', () => {
  // Pre-fix behavior: validateApiKey({ Referer: https://worldmonitor.app/ }) returned valid=true.
  // Post-fix: Referer is ignored; this request must be rejected.
  const req = makeReq({ referer: 'https://worldmonitor.app/' });
  const result = validateApiKey(req);
  assert.equal(result.valid, false, 'fake Referer must NOT trust the request');
  assert.equal(result.required, true);
});

test('issue #3541 — curl with fake Referer AND fake Sec-Fetch-Site cannot bypass', () => {
  // Sec-Fetch-Site is on the Forbidden Header list, so the browser overwrites
  // it. But we verify defense-in-depth: even if a client tries to set BOTH,
  // we never accept Referer signals.
  const req = makeReq({
    referer: 'https://worldmonitor.app/',
    secFetchSite: 'cross-site',
  });
  const result = validateApiKey(req);
  assert.equal(result.valid, false);
});

test('browser same-origin request (no Origin, Sec-Fetch-Site: same-origin) is trusted', () => {
  const req = makeReq({ secFetchSite: 'same-origin' });
  const result = validateApiKey(req);
  assert.equal(result.valid, true);
  assert.equal(result.required, false);
});

test('browser cross-origin request with explicit Origin worldmonitor.app is trusted', () => {
  const req = makeReq({ origin: 'https://worldmonitor.app', secFetchSite: 'same-site' });
  const result = validateApiKey(req);
  assert.equal(result.valid, true);
});

test('browser cross-origin request with subdomain Origin (tech.worldmonitor.app) is trusted', () => {
  const req = makeReq({ origin: 'https://tech.worldmonitor.app', secFetchSite: 'same-site' });
  const result = validateApiKey(req);
  assert.equal(result.valid, true);
});

test('browser request with attacker Origin is rejected', () => {
  const req = makeReq({ origin: 'https://evil.example.com' });
  const result = validateApiKey(req);
  assert.equal(result.valid, false);
});

test('Sec-Fetch-Site: cross-site (no Origin) is NOT trusted', () => {
  // A cross-site nav from attacker.com that strips Origin somehow — should not pass.
  const req = makeReq({ secFetchSite: 'cross-site' });
  const result = validateApiKey(req);
  assert.equal(result.valid, false);
});

test('Sec-Fetch-Site: none (top-level navigation) is NOT trusted for API endpoints', () => {
  // Direct URL-bar navigation to /api/foo — should not be classified as a
  // browser app request. Only same-origin counts.
  const req = makeReq({ secFetchSite: 'none' });
  const result = validateApiKey(req);
  assert.equal(result.valid, false);
});

test('Sec-Fetch-Site: same-site (no Origin) is NOT trusted (defensive)', () => {
  // Browsers send Origin on same-site cross-host requests, so this combo
  // shouldn't occur in practice. Reject defensively.
  const req = makeReq({ secFetchSite: 'same-site' });
  const result = validateApiKey(req);
  assert.equal(result.valid, false);
});

test('valid API key from any origin is accepted', () => {
  const req = makeReq({ origin: 'https://anywhere.example.com', key: VALID_KEY });
  const result = validateApiKey(req);
  assert.equal(result.valid, true);
  assert.equal(result.required, true);
});

test('invalid API key from any origin is rejected', () => {
  const req = makeReq({ origin: 'https://anywhere.example.com', key: 'wrong' });
  const result = validateApiKey(req);
  assert.equal(result.valid, false);
});

test('desktop Tauri origin without key is rejected', () => {
  const req = makeReq({ origin: 'tauri://localhost' });
  const result = validateApiKey(req);
  assert.equal(result.valid, false);
  assert.equal(result.error, 'API key required for desktop access');
});

test('desktop Tauri origin with valid key is accepted', () => {
  const req = makeReq({ origin: 'tauri://localhost', key: VALID_KEY });
  const result = validateApiKey(req);
  assert.equal(result.valid, true);
});

test('desktop Tauri origin with invalid key is rejected', () => {
  const req = makeReq({ origin: 'tauri://localhost', key: 'wrong' });
  const result = validateApiKey(req);
  assert.equal(result.valid, false);
  assert.equal(result.error, 'Invalid API key');
});

test('forceKey=true requires key even from trusted browser origin', () => {
  const req = makeReq({ origin: 'https://worldmonitor.app' });
  const result = validateApiKey(req, { forceKey: true });
  assert.equal(result.valid, false);
});

test('forceKey=true requires key even on same-origin Sec-Fetch-Site', () => {
  const req = makeReq({ secFetchSite: 'same-origin' });
  const result = validateApiKey(req, { forceKey: true });
  assert.equal(result.valid, false);
});

test('forceKey=true with valid key from same-origin browser is accepted', () => {
  const req = makeReq({ secFetchSite: 'same-origin', key: VALID_KEY });
  const result = validateApiKey(req, { forceKey: true });
  assert.equal(result.valid, true);
});

test('completely unauthenticated request (no Origin, no Sec-Fetch-Site, no key) is rejected', () => {
  const req = makeReq({});
  const result = validateApiKey(req);
  assert.equal(result.valid, false);
  assert.equal(result.required, true);
});
