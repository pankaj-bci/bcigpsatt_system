-- Phase 3: geofencing + GPS accuracy gate.
-- Ported from legacy-apps-script/locationutils.gs (Loc_haversineDistance,
-- Loc_validateAccuracy, Loc_validatePunchIn, Loc_validatePunchOut) and the
-- location-validation block of legacy-apps-script/attendanceengine.gs
-- (Attendance_processPunch steps 2-3). See .claude/plan.md Appendix A (GPS
-- rules) and Appendix C-8 (punch validates against the frontend-selected
-- location tile, not employees.assigned_location_id -- replicated exactly).

-- Distance in metres between two GPS points (haversine formula).
-- Matches Loc_haversineDistance() bit-for-bit, including its round-to-1-decimal.
create or replace function haversine_distance_meters(
  lat1 double precision, lon1 double precision,
  lat2 double precision, lon2 double precision
) returns double precision
language plpgsql
immutable
parallel safe
as $$
declare
  r constant double precision := 6371000;
  p1 double precision := radians(lat1);
  p2 double precision := radians(lat2);
  dlat double precision := radians(lat2 - lat1);
  dlon double precision := radians(lon2 - lon1);
  a double precision;
  c double precision;
begin
  a := sin(dlat / 2) ^ 2 + cos(p1) * cos(p2) * sin(dlon / 2) ^ 2;
  c := 2 * atan2(sqrt(a), sqrt(1 - a));
  return round((r * c)::numeric, 1)::double precision;
end;
$$;

-- Matches Loc_validateAccuracy(): reject null/zero/negative or > 100m.
-- (CONFIG.GPS_MAX_ACCURACY_METERS = 100)
create or replace function is_gps_accuracy_valid(accuracy_meters double precision)
returns boolean
language sql
immutable
parallel safe
as $$
  select accuracy_meters is not null and accuracy_meters > 0 and accuracy_meters <= 100;
$$;

-- Validates a punch's GPS location. Mirrors Attendance_processPunch's
-- location-validation branch exactly:
--   * p_location_id = 'WFH' or 'OTHER' -> inverted distance-from-office check
--     (CONFIG.WFH_MIN_DISTANCE_METERS = 5000, OTHER_MIN_DISTANCE_METERS = 2000).
--   * otherwise -> standard geofence against the SELECTED location (p_location_id),
--     falling back to p_assigned_location_id only when p_location_id is null
--     (C-8 -- this fallback is defensive; the real frontend always sends a tile).
--     IN must be within that location's radius. OUT is valid within that
--     location's radius OR within head office's (L1) radius.
create or replace function validate_punch_location(
  p_action punch_action,
  p_location_id text,
  p_assigned_location_id text,
  p_lat double precision,
  p_lon double precision
) returns table (
  valid boolean,
  location_type location_type,
  location_name text,
  distance_meters double precision
)
language plpgsql
stable
as $$
declare
  v_office        locations%rowtype;
  v_target        locations%rowtype;
  v_effective_id  text;
  v_dist          double precision;
  v_min_dist      double precision;
  v_office_dist   double precision;
  v_valid         boolean;
  v_loc_type      location_type;
  v_loc_name      text;
begin
  select * into v_office from locations where location_id = 'L1';
  if not found then
    raise exception 'Head office location (L1) is not configured';
  end if;

  if p_location_id in ('WFH', 'OTHER') then
    v_dist := haversine_distance_meters(p_lat, p_lon, v_office.latitude, v_office.longitude);
    v_min_dist := case when p_location_id = 'WFH' then 5000 else 2000 end;
    v_valid := v_dist > v_min_dist;
    v_loc_type := p_location_id::location_type;
    v_loc_name := case when p_location_id = 'WFH' then 'Work From Home' else 'Other' end;
    return query select v_valid, v_loc_type, v_loc_name, v_dist;
    return;
  end if;

  v_effective_id := coalesce(p_location_id, p_assigned_location_id);
  select * into v_target from locations where location_id = v_effective_id;
  if not found then
    return query select false, null::location_type, null::text, null::double precision;
    return;
  end if;

  v_loc_type := case when v_target.location_id = v_office.location_id then 'HEAD_OFFICE'::location_type else 'WORKSHOP'::location_type end;
  v_loc_name := v_target.location_name;
  v_dist := haversine_distance_meters(p_lat, p_lon, v_target.latitude, v_target.longitude);
  v_valid := v_dist <= v_target.radius;

  if p_action = 'OUT' and not v_valid and v_target.location_id <> v_office.location_id then
    v_office_dist := haversine_distance_meters(p_lat, p_lon, v_office.latitude, v_office.longitude);
    if v_office_dist <= v_office.radius then
      v_valid := true;
      v_loc_type := 'HEAD_OFFICE';
      v_loc_name := v_office.location_name;
      v_dist := v_office_dist;
    end if;
  end if;

  return query select v_valid, v_loc_type, v_loc_name, v_dist;
end;
$$;

grant execute on function haversine_distance_meters(double precision, double precision, double precision, double precision) to authenticated;
grant execute on function is_gps_accuracy_valid(double precision) to authenticated;
grant execute on function validate_punch_location(punch_action, text, text, double precision, double precision) to authenticated;
