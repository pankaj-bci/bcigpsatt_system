// =============================================================================
// FILE: LocationUtils.gs
// PURPOSE: GPS math and location validation. All prefixed "Loc_"
// =============================================================================

/**
 * Loc_haversineDistance()
 * PURPOSE: Calculate distance in metres between two GPS coordinates.
 * @param  {number} lat1, lon1, lat2, lon2
 * @return {number} metres
 */
function Loc_haversineDistance(lat1, lon1, lat2, lon2) {
  var R = 6371000;
  var p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
  var dp = (lat2 - lat1) * Math.PI / 180;
  var dl = (lon2 - lon1) * Math.PI / 180;
  var a  = Math.sin(dp/2)*Math.sin(dp/2) + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)*Math.sin(dl/2);
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)) * 10) / 10;
}

/**
 * Loc_isWithinRadius()
 * @param  {number} uLat, uLon
 * @param  {Object} location - {latitude, longitude, radius, location_name}
 * @return {Object} {withinRadius, distance, locationName}
 */
function Loc_isWithinRadius(uLat, uLon, location) {
  var dist = Loc_haversineDistance(uLat, uLon, location.latitude, location.longitude);
  return { withinRadius: dist <= location.radius, distance: dist, locationName: location.location_name };
}

/**
 * Loc_validateAccuracy()
 * @param  {number} accuracy - metres from browser
 * @return {Object} {valid, message}
 */
function Loc_validateAccuracy(accuracy) {
  if (!accuracy || accuracy > CONFIG.GPS_MAX_ACCURACY_METERS) {
    return { valid:false, message:'GPS accuracy too low (' + Math.round(accuracy||0) + 'm). Move to an open area. Required: ≤' + CONFIG.GPS_MAX_ACCURACY_METERS + 'm.' };
  }
  return { valid:true, message:'GPS accuracy OK: ' + Math.round(accuracy) + 'm.' };
}

/**
 * Loc_validatePunchIn()
 * RULE: Punch IN only from ASSIGNED location.
 * @param  {number} uLat, uLon
 * @param  {Object} assigned
 * @return {Object} {valid, message}
 */
function Loc_validatePunchIn(uLat, uLon, assigned) {
  var c = Loc_isWithinRadius(uLat, uLon, assigned);
  if (c.withinRadius) return { valid:true, message:'✅ Location verified at ' + c.locationName + ' (' + c.distance + 'm).' };
  return { valid:false, message:'❌ Punch IN rejected. Must be at assigned location: ' + assigned.location_name + '. You are ' + c.distance + 'm away (allowed: ' + assigned.radius + 'm).' };
}

/**
 * Loc_validatePunchOut()
 * RULE: Punch OUT from ASSIGNED location OR default OFFICE.
 * @param  {number} uLat, uLon
 * @param  {Object} assigned
 * @param  {Object} office
 * @return {Object} {valid, message, matchedAt}
 */
function Loc_validatePunchOut(uLat, uLon, assigned, office) {
  var ca = Loc_isWithinRadius(uLat, uLon, assigned);
  if (ca.withinRadius) return { valid:true, message:'✅ Punch OUT at ' + ca.locationName + ' (' + ca.distance + 'm).', matchedAt:'assigned' };

  if (assigned.location_id !== office.location_id) {
    var co = Loc_isWithinRadius(uLat, uLon, office);
    if (co.withinRadius) return { valid:true, message:'✅ Punch OUT at office (' + co.distance + 'm).', matchedAt:'office' };
    return { valid:false, message:'❌ Punch OUT rejected. Distance to ' + assigned.location_name + ': ' + ca.distance + 'm. Distance to office: ' + co.distance + 'm.', matchedAt:'none' };
  }
  return { valid:false, message:'❌ Punch OUT rejected. You are ' + ca.distance + 'm from ' + assigned.location_name + ' (allowed: ' + assigned.radius + 'm).', matchedAt:'none' };
}

/**
 * Loc_reverseGeocode()
 * PURPOSE: Convert lat/lon to a human-readable address using the built-in
 *          Google Maps geocoder (no API key required in Apps Script).
 * @param  {number} lat
 * @param  {number} lon
 * @return {string} formatted address, or '' on failure
 */
function Loc_reverseGeocode(lat, lon) {
  try {
    var result = Maps.newGeocoder().reverseGeocode(lat, lon);
    if (result.status === 'OK' && result.results && result.results[0]) {
      return result.results[0].formatted_address;
    }
  } catch (e) {
    Logger.log('Loc_reverseGeocode error: ' + e.message);
  }
  return '';
}