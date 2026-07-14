-- Phase 3: record_punch() -- the atomic punch RPC.
-- Ported from legacy-apps-script/attendanceengine.gs (Attendance_processPunch),
-- combining: employee/status lookup, GPS accuracy gate, geofence, anti-fraud,
-- the punch insert, and same-day re-evaluation -- all in one transaction.
--
-- Security tightening vs the Phase 1 RLS design: the original
-- "staff insert own punches" policy let an authenticated client insert
-- punch_logs directly (any lat/lon, any location, no validation at all) as
-- long as emp_id matched themselves. That made sense before this RPC
-- existed; now it's a bypass of every check below. This migration drops
-- that policy and makes record_punch() SECURITY DEFINER, so it becomes the
-- only path that can write to punch_logs as a non-admin.
--
-- Locking: Section 6.2 calls for a per-employee advisory lock instead of
-- the old global ScriptLock. pg_advisory_xact_lock() auto-releases at
-- transaction end (commit or rollback) -- no manual unlock needed, and it
-- only blocks OTHER transactions taking the same lock key (same employee),
-- so concurrent punches from different employees never wait on each other.

drop policy if exists "staff insert own punches" on punch_logs;

create or replace function record_punch(
  p_action punch_action,
  p_location_id text,           -- 'L1'..'L4', 'WFH', 'OTHER', or null
  p_lat double precision,
  p_lon double precision,
  p_accuracy double precision
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

  -- 2. Geofence (C-8: validates against the SELECTED tile, falling back to
  --    assigned_location_id only if none was sent)
  select * into v_loc from validate_punch_location(p_action, p_location_id, v_emp.assigned_location_id, p_lat, p_lon);
  if not v_loc.valid then
    return query select false, 'Location check failed — you are not within the allowed radius.'::text, null::text;
    return;
  end if;

  -- 3. Anti-fraud (re-checked INSIDE the advisory lock, closing the race
  --    window between any earlier client-side check and this transaction)
  select * into v_fraud from validate_punch_anti_fraud(v_emp.emp_id, p_action);
  if not v_fraud.valid then
    return query select false, v_fraud.message, null::text;
    return;
  end if;

  -- 4. Insert the punch
  insert into punch_logs (emp_id, action, punched_at, latitude, longitude, location_type, location_name)
  values (v_emp.emp_id, p_action, now(), p_lat, p_lon, v_loc.location_type, v_loc.location_name);

  -- 5. Re-evaluate today's attendance_summary row (IST calendar day)
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

grant execute on function record_punch(punch_action, text, double precision, double precision, double precision) to authenticated;
