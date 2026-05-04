/**
 * Auto-fill bookings.latitude / bookings.longitude from the address
 * fields when the user hasn't set them manually. Called after every
 * booking insert / update so a booking always has coordinates if its
 * address is geocodable.
 *
 * Strategy:
 *  - If marker_is_accurate is set, the user dropped a pin — leave alone.
 *  - If lat/lng are already set AND the address text hasn't changed,
 *    leave alone.
 *  - Otherwise build a query string from
 *      [site_address, suburb, state, postcode, 'Australia']
 *    and hit Open-Meteo's geocoder (already used by the worker home
 *    weather card). Suburb-level precision is good enough for the
 *    operational use cases — distance bands, regional grouping. A
 *    follow-up can swap to a street-level provider if needed.
 *
 * Best-effort: failures are logged and swallowed. The booking save
 * never blocks on geocoding errors.
 */
const { getDb } = require('../db/database');
const { geocodeAddress } = require('./homeContext');

function buildQuery(b) {
  return [b.site_address, b.suburb, b.state, b.postcode, 'Australia']
    .map(s => (s == null ? '' : String(s).trim()))
    .filter(Boolean)
    .join(', ');
}

async function geocodeBookingIfNeeded(bookingId, opts = {}) {
  try {
    const db = getDb();
    const b = db.prepare('SELECT id, site_address, suburb, state, postcode, latitude, longitude, marker_is_accurate FROM bookings WHERE id = ?').get(bookingId);
    if (!b) return null;
    if (b.marker_is_accurate) return null;     // user-placed pin wins
    const force = !!opts.force;
    const hasCoords = b.latitude != null && b.longitude != null;
    if (hasCoords && !force) return null;       // already coordinated
    const q = buildQuery(b);
    if (!q) return null;                        // nothing to geocode
    const geo = await geocodeAddress(q);
    if (!geo || geo.lat == null || geo.lng == null) return null;
    db.prepare('UPDATE bookings SET latitude = ?, longitude = ? WHERE id = ?')
      .run(geo.lat, geo.lng, bookingId);
    return geo;
  } catch (e) {
    console.warn('[bookingGeocode] failed for booking', bookingId, ':', e.message);
    return null;
  }
}

module.exports = { geocodeBookingIfNeeded, buildQuery };
