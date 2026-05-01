const DESKTOP_ORIGIN_PATTERNS = [
  /^https?:\/\/tauri\.localhost(:\d+)?$/,
  /^https?:\/\/[a-z0-9-]+\.tauri\.localhost(:\d+)?$/i,
  /^tauri:\/\/localhost$/,
  /^asset:\/\/localhost$/,
];

const BROWSER_ORIGIN_PATTERNS = [
  /^https:\/\/(.*\.)?worldmonitor\.app$/,
  /^https:\/\/worldmonitor-[a-z0-9-]+-elie-[a-z0-9]+\.vercel\.app$/,
  ...(process.env.NODE_ENV === 'production' ? [] : [
    /^https?:\/\/localhost(:\d+)?$/,
    /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  ]),
];

function isDesktopOrigin(origin) {
  return Boolean(origin) && DESKTOP_ORIGIN_PATTERNS.some(p => p.test(origin));
}

function isTrustedBrowserOrigin(origin) {
  return Boolean(origin) && BROWSER_ORIGIN_PATTERNS.some(p => p.test(origin));
}

// Sec-Fetch-Site is on the Forbidden Header list — set ONLY by the browser at
// request time, never by client JS or non-browser HTTP clients (curl, Node fetch,
// Python requests). 'same-origin' = strict same-origin browser fetch.
//
// Replaced an earlier Referer-origin fallback (issue #3541) which trusted a
// client-controlled header: `curl -H "Referer: https://worldmonitor.app/"`
// with no Origin was classified as a trusted browser, bypassing the API-key
// gate entirely. Sec-Fetch-Site is unforgeable; Referer is not.
function isSameOriginBrowserRequest(req) {
  return req.headers.get('Sec-Fetch-Site') === 'same-origin';
}

function isValidKey(key) {
  if (!key) return false;
  const validKeys = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);
  return validKeys.includes(key);
}

export function validateApiKey(req, options = {}) {
  const forceKey = options.forceKey === true;
  const key = req.headers.get('X-WorldMonitor-Key') || req.headers.get('X-Api-Key');
  const origin = req.headers.get('Origin') || '';

  // Desktop app — always require API key
  if (isDesktopOrigin(origin)) {
    if (!key) return { valid: false, required: true, error: 'API key required for desktop access' };
    if (!isValidKey(key)) return { valid: false, required: true, error: 'Invalid API key' };
    return { valid: true, required: true };
  }

  // Browser request from a trusted origin — either explicit Origin matches our
  // hosts, or Origin is absent (CORS spec omits it on same-origin same-document
  // requests) AND the unforgeable Sec-Fetch-Site header confirms same-origin.
  const isTrustedBrowser = isTrustedBrowserOrigin(origin)
    || (!origin && isSameOriginBrowserRequest(req));

  if (isTrustedBrowser) {
    if (forceKey && !key) {
      return { valid: false, required: true, error: 'API key required' };
    }
    if (key && !isValidKey(key)) {
      return { valid: false, required: true, error: 'Invalid API key' };
    }
    return { valid: true, required: forceKey };
  }

  // Explicit key provided from unknown origin — validate it
  if (key) {
    if (!isValidKey(key)) return { valid: false, required: true, error: 'Invalid API key' };
    return { valid: true, required: true };
  }

  // No trusted origin signal, no key — require API key (blocks curl/scripts)
  return { valid: false, required: true, error: 'API key required' };
}
