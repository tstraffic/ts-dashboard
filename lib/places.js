// Geoapify address autocomplete — the shared proxy behind every module's
// address picker. Extracted from routes/bookings.js so pages outside the
// bookings permission (Plans & Approvals' New Plan form) can mount the same
// handler under their own prefix instead of being locked out by the
// /bookings gate.
//
// AU-biased, returns up to 8 suggestions shaped { label, formatted, lat, lng,
// site_address, suburb, state, postcode } so a picker can populate its hidden
// fields straight from the result.
//
// Key resolution chain (matches services/bookingGeocode.getGoogleKey):
//   1. GEOAPIFY_API_KEY env var (preferred — easy to rotate per-env)
//   2. system_config 'geoapify_api_key' row (settable from /settings)
// Without a key the handler degrades gracefully: `{ results: [], error }`,
// and the client falls back to manual typing.

'use strict';

const { getConfig } = require('../middleware/settings');

function getGeoapifyKey() {
  return process.env.GEOAPIFY_API_KEY
      || getConfig('geoapify_api_key', '');
}

async function placesHandler(req, res) {
  const q = (req.query.q || '').trim();
  if (q.length < 3) return res.json({ results: [] });
  const key = getGeoapifyKey();
  if (!key) return res.json({ results: [], error: 'No Geoapify key configured' });
  // Optional country bias: client passes ?cc=au. bias= is a preference, not a
  // restriction (filter=), so interstate/overseas addresses stay findable.
  const cc = String(req.query.cc || '').trim().toLowerCase().replace(/[^a-z]/g, '').slice(0, 2);
  const biasParam = cc ? ('&bias=countrycode:' + cc) : '';
  try {
    const url = 'https://api.geoapify.com/v1/geocode/autocomplete'
      + '?text=' + encodeURIComponent(q)
      + biasParam
      + '&apiKey=' + encodeURIComponent(key);
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error('[places] geoapify error', resp.status);
      return res.json({ results: [], error: 'Geoapify HTTP ' + resp.status });
    }
    const json = await resp.json();
    const features = Array.isArray(json.features) ? json.features : [];
    const results = features.slice(0, 8).map(f => {
      const p = f.properties || {};
      const geom = f.geometry && Array.isArray(f.geometry.coordinates) ? f.geometry.coordinates : null;
      // GeoJSON has [lon, lat]; properties.lon/.lat are also populated.
      const lng = (typeof p.lon === 'number') ? p.lon : (geom ? geom[0] : null);
      const lat = (typeof p.lat === 'number') ? p.lat : (geom ? geom[1] : null);
      const street = [p.housenumber, p.street].filter(Boolean).join(' ').trim();
      const stateRaw = String(p.state_code || p.state || '').trim();
      const stateMatch = stateRaw.match(/\b(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b/i);
      const stateNorm = stateMatch ? stateMatch[1].toUpperCase() : stateRaw;
      return {
        label: p.formatted || p.address_line1 || p.name || '',
        formatted: p.formatted || '',
        lat: lat,
        lng: lng,
        site_address: street || p.address_line1 || p.name || '',
        suburb: p.suburb || p.city || p.town || p.village || p.county || '',
        state: stateNorm,
        postcode: p.postcode || '',
      };
    });
    res.json({ results });
  } catch (e) {
    console.error('[places] failed', e.message);
    res.json({ results: [], error: e.message });
  }
}

module.exports = { getGeoapifyKey, placesHandler };
