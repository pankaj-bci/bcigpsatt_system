-- Phase 7 (v2), Task A: strict 1:1 device binding -- the buddy-punching fix.
--
-- Threat model: record_punch() already guarantees WHO (emp_id from the JWT)
-- and WHERE (geofence), but not WHICH PHONE. An employee holding a
-- colleague's login can stand at the venue and punch for them. Binding one
-- device to one employee (and one employee to one device) closes that:
--   - employee_devices.emp_id is the PK  -> one device per employee
--   - employee_devices.device_id UNIQUE  -> one employee per device
-- The client sends a random UUID it persists locally (localStorage+cookie);
-- the first valid punch binds it. A new phone shows up as an unknown device
-- and is rejected until an admin deletes the binding ("Reset device").
--
-- Rollout safety: enforcement is gated by app_config.device_enforcement
-- ('off' initially). While 'off', a punch with no device id behaves exactly
-- as today -- so deploying this migration BEFORE the new frontend locks
-- nobody out. Flip to 'on' (single UPDATE) once every active employee has
-- punched at least once with the new client and auto-bound.
--
-- No bindings-history table: every punch now records its device_id in
-- punch_logs, which is a richer forensic trail than binding history would
-- be. Admin reset is therefore a plain DELETE.

create table employee_devices (
  emp_id       text primary key references employees(emp_id) on delete cascade,
  device_id    uuid not null unique,
  bound_at     timestamptz not null default now(),
  last_seen_at timestamptz,
  user_agent   text,
  label        text
);

alter table punch_logs add column device_id uuid;

create table app_config (
  key   text primary key,
  value text not null
);

insert into app_config (key, value) values ('device_enforcement', 'off');

-- RLS: same shape as the rest of the schema (20260713010000_rls_policies.sql).
alter table employee_devices enable row level security;
create policy "staff read own device" on employee_devices
  for select using (emp_id = current_employee_id());
create policy "admins full access to employee_devices" on employee_devices
  for all using (is_admin()) with check (is_admin());

-- app_config: admin-only. record_punch() is SECURITY DEFINER, so it reads
-- this table regardless; no staff policy needed.
alter table app_config enable row level security;
create policy "admins manage app_config" on app_config
  for all using (is_admin()) with check (is_admin());

grant select, insert, update, delete on employee_devices to authenticated;
grant select, update on app_config to authenticated;

-- Rebuild record_punch with p_device_id/p_user_agent. CREATE OR REPLACE with
-- new defaulted params would create an OVERLOAD (PostgREST then fails with
-- PGRST203 ambiguity), so the old signature is dropped in the same
-- transaction -- atomic, no window where the RPC is missing.
drop function record_punch(punch_action, text, double precision, double precision, double precision);

create function record_punch(
  p_action punch_action,
  p_location_id text,           -- 'L1'..'L4', 'WFH', 'OTHER', or null
  p_lat double precision,
  p_lon double precision,
  p_accuracy double precision,
  p_device_id uuid default null,
  p_user_agent text default null
) returns table (
  success boolean,
  message text,
  status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  tz constant text := 'Asia/Kolkata';
  v_emp employees%rowtype;
  v_dev employee_devices%rowtype;
  v_loc record;
  v_fraud record;
  v_today date;
  v_has_any_punch boolean;
  v_first_in time;
  v_last_out time;
  v_holiday_name text;
  v_is_holiday boolean;
  v_counters record;
  v_eval day_evaluation;
begin
  -- Resolve employee from the caller's own session -- never trust a
  -- client-supplied emp_id (this is what makes SECURITY DEFINER safe here:
  -- the function decides WHO, the caller only decides WHAT).
  select * into v_emp from employees where emp_id = current_employee_id();
  if not found then
    return query select false, 'Your account is not linked to an employee record. Contact admin.'::text, null::text;
    return;
  end if;
  if v_emp.status <> 'Active' then
    return query select false, 'Your account is currently Inactive. Contact admin.'::text, null::text;
    return;
  end if;

  -- Per-employee advisory lock -- serializes only this employee's own punches.
  perform pg_advisory_xact_lock(hashtext(v_emp.emp_id));

  -- 1. GPS accuracy gate
  if not is_gps_accuracy_valid(p_accuracy) then
    return query select false,
      format('GPS accuracy too low (%sm). Move to an open area. Required: <=100m.', coalesce(round(p_accuracy)::text, '0')),
      null::text;
    return;
  end if;

  -- 2. Device binding (strict 1:1). Runs inside the advisory lock, before
  --    the geodesic math -- a PK lookup is the cheapest remaining check.
  if p_device_id is not null then
    select * into v_dev from employee_devices where emp_id = v_emp.emp_id;
    if found then
      if v_dev.device_id <> p_device_id then
        return query select false,
          'This account is registered to a different phone. Ask your admin to reset your device, then punch again.'::text,
          null::text;
        return;
      end if;
      update employee_devices set last_seen_at = now() where emp_id = v_emp.emp_id;
    else
      -- First punch from this account: auto-bind. The UNIQUE(device_id)
      -- constraint (not a racy pre-check) enforces one-employee-per-device;
      -- a violation means this phone already belongs to someone else.
      begin
        insert into employee_devices (emp_id, device_id, user_agent, last_seen_at)
        values (v_emp.emp_id, p_device_id, left(p_user_agent, 256), now());
      exception when unique_violation then
        return query select false,
          'This phone is already registered to another employee. Punch from your own phone, or contact admin.'::text,
          null::text;
        return;
      end;
    end if;
  else
    -- No device id: old clients during rollout. Allowed only while the
    -- enforcement flag is off; once 'on', omitting the id is a bypass
    -- attempt (or a stale tab) and gets rejected.
    if (select value from app_config where key = 'device_enforcement') = 'on' then
      return query select false,
        'App updated — please refresh this page and punch again.'::text, null::text;
      return;
    end if;
  end if;

  -- 3. Geofence (C-8: validates against the SELECTED tile, falling back to
  --    assigned_location_id only if none was sent)
  select * into v_loc from validate_punch_location(p_action, p_location_id, v_emp.assigned_location_id, p_lat, p_lon);
  if not v_loc.valid then
    return query select false, 'Location check failed — you are not within the allowed radius.'::text, null::text;
    return;
  end if;

  -- 4. Anti-fraud (re-checked INSIDE the advisory lock, closing the race
  --    window between any earlier client-side check and this transaction)
  select * into v_fraud from validate_punch_anti_fraud(v_emp.emp_id, p_action);
  if not v_fraud.valid then
    return query select false, v_fraud.message, null::text;
    return;
  end if;

  -- 5. Insert the punch (device_id kept per punch as the forensic trail)
  insert into punch_logs (emp_id, action, punched_at, latitude, longitude, location_type, location_name, device_id)
  values (v_emp.emp_id, p_action, now(), p_lat, p_lon, v_loc.location_type, v_loc.location_name, p_device_id);

  -- 6. Re-evaluate today's attendance_summary row (IST calendar day)
  v_today := (now() at time zone tz)::date;

  select
    count(*) > 0,
    (min(punched_at) filter (where action = 'IN')) at time zone tz,
    (max(punched_at) filter (where action = 'OUT')) at time zone tz
  into v_has_any_punch, v_first_in, v_last_out
  from punch_logs
  where emp_id = v_emp.emp_id
    and punched_at >= (v_today::timestamp at time zone tz)
    and punched_at < ((v_today + 1)::timestamp at time zone tz);

  select (date is not null), holiday_name into v_is_holiday, v_holiday_name
  from holidays where date = v_today;
  v_is_holiday := coalesce(v_is_holiday, false);

  select * into v_counters from compute_monthly_counters(v_emp.emp_id, v_today);

  v_eval := evaluate_day(
    v_emp.employee_type, v_today, v_has_any_punch, v_first_in, v_last_out,
    v_is_holiday, v_holiday_name,
    coalesce(v_counters.late_early_used, 0), coalesce(v_counters.leave_credits_used, 0)
  );

  insert into attendance_summary (
    emp_id, date, in_time, out_time, status, late_flag, early_flag,
    half_day_flag, working_sunday, leave_credit_used, notes
  ) values (
    v_emp.emp_id, v_today, v_eval.in_time, v_eval.out_time, v_eval.status,
    v_eval.late_flag, v_eval.early_flag, v_eval.half_day_flag,
    v_eval.working_sunday, v_eval.leave_credit_used, v_eval.notes
  )
  on conflict (emp_id, date) do update set
    in_time = excluded.in_time,
    out_time = excluded.out_time,
    status = excluded.status,
    late_flag = excluded.late_flag,
    early_flag = excluded.early_flag,
    half_day_flag = excluded.half_day_flag,
    working_sunday = excluded.working_sunday,
    leave_credit_used = excluded.leave_credit_used,
    notes = excluded.notes;

  return query select true,
    format('%s — Punch %s recorded at %s.', v_loc.location_name, p_action, to_char(now() at time zone tz, 'HH24:MI:SS')),
    v_eval.status;
end;
$$;

grant execute on function record_punch(punch_action, text, double precision, double precision, double precision, uuid, text) to authenticated;
