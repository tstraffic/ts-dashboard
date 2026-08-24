// Sanitise a `?back=` query param for the worker portal's full-screen
// viewers. Those pages sit on layout-bare — no bottom tab nav — so the back
// chevron is the only way out, and its href comes from the URL. Only ever
// hand back an internal /w/ path: anything else (absolute URL, //host,
// javascript:, an admin path) falls through to the caller's fallback.
function safeWorkerBack(value, fallback) {
  if (typeof value !== 'string') return fallback;
  // Reject '//host' — it starts with '/' but is protocol-relative and leaves
  // the origin. '/w/' already excludes it, but be explicit for future edits.
  if (value.startsWith('//')) return fallback;
  return value.startsWith('/w/') ? value : fallback;
}

module.exports = { safeWorkerBack };
