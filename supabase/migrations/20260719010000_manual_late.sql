-- Phase 7 (v2), Task B: admin "Mark Late" with full policy consequences.
--
-- Problem: workshop days start earlier than the global 09:30 shift (e.g.
-- 08:00) and the timing is ad hoc per event, so the policy engine cannot
-- auto-detect workshop lateness. An admin marks the employee late from the
-- Today dashboard instead -- and the mark must carry the SAME consequences
-- as a system-detected late: it consumes the 3-free-late monthly allowance
-- and participates in the 4th-late -> Half Day escalation.
--
-- Mechanism: the mark is stored in dedicated attendance_summary columns
-- (manual_late*) that no evaluation upsert touches, and manual_late is
-- threaded INTO evaluate_day() as a new parameter. Every recompute path
-- (record_punch on punch-out, admin re-marks, retro cascade) therefore
-- reproduces the late consequences instead of clobbering them. Downstream
-- consumers (compute_monthly_counters, generate_monthly_summary, backfill's
-- counter seeding) just sum late_flag, which the engine now sets -- they
-- need zero changes. backfill_missing_days only creates rows that don't
-- exist, and a mark requires an existing row, so it can never overwrite one.
--
-- Signature changes use DROP + CREATE (not CREATE OR REPLACE) because a new
-- defaulted parameter would otherwise create an overload -> PGRST203 /
-- ambiguous-call errors. Same-transaction, so there is no live gap.

alter table attendance_summary
  add column manual_late      boolean not null default false,
  add column manual_late_note text,
  add column manual_late_by   text,
  add column manual_late_at   timestamptz;

-- The Today dashboard now reads attendance_summary by date across ALL
-- employees (one query per page load); the (emp_id, date) PK can't serve a
-- date-only filter, and this table grows by one row per employee per day.
create index on attendance_summary (date);

-- ---------------------------------------------------------------------------
-- 1. evaluate_probation: manual late counts as a late violation (zero
--    tolerance => Half Day, same as any probation late).
-- ---------------------------------------------------------------------------
drop function evaluate_probation(time, time);

create function evaluate_probation(
  p_first_in time,
  p_last_out time,
  p_manual_late boolean default false
) returns day_evaluation
language plpgsql
stable
as $$
declare
  v_result day_evaluation;
  shift_end constant int := 1110;   -- 18:30
  late_limit constant int := 576;   -- 09:36 (shift_start 570 + PROBATION.LATE_THRESHOLD_MINUTES 6)
  v_in_minutes int := case when p_first_in is null then null else extract(hour from p_first_in)::int * 60 + extract(minute from p_first_in)::int end;
  v_out_minutes int := case when p_last_out is null then null else extract(hour from p_last_out)::int * 60 + extract(minute from p_last_out)::int end;
  v_late_violation boolean := (v_in_minutes is null or v_in_minutes > late_limit) or p_manual_late;
  v_early_violation boolean := (v_out_minutes is null or v_out_minutes < shift_end);
  v_msgs text[] := '{}';
begin
  v_result.working_sunday := false;
  v_result.leave_credit_used := 0;
  v_result.late_early_delta := 0;

  if v_late_violation or v_early_violation then
    if v_late_violation then
      v_msgs := array_append(v_msgs, 'Late IN: ' || coalesce(p_first_in::text, 'No punch'));
    end if;
    if p_manual_late then
      v_msgs := array_append(v_msgs, 'Marked late by admin');
    end if;
    if v_early_violation then
      v_msgs := array_append(v_msgs, 'Early OUT: ' || coalesce(p_last_out::text, 'No punch'));
    end if;
    v_result.status := 'Half Day';
    v_result.in_time := p_first_in;
    v_result.out_time := p_last_out;
    v_result.late_flag := v_late_violation;
    v_result.early_flag := v_early_violation;
    v_result.half_day_flag := true;
    v_result.notes := 'Probation violation — ' || array_to_string(v_msgs, '; ');
    return v_result;
  end if;

  v_result.status := 'Present';
  v_result.in_time := p_first_in;
  v_result.out_time := p_last_out;
  v_result.late_flag := false;
  v_result.early_flag := false;
  v_result.half_day_flag := false;
  v_result.notes := '';
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. evaluate_fixed: a manual late on an otherwise on-time IN reclassifies
--    it as 'late' BEFORE the Case 1..4 logic runs, so allowance consumption
--    and the 4th-late Half-Day conversion apply verbatim. If the IN was
--    already late/halfday/absent the mark changes nothing (the day is
--    already at >= late severity).
-- ---------------------------------------------------------------------------
drop function evaluate_fixed(time, time, int, numeric);

create function evaluate_fixed(
  p_first_in time,
  p_last_out time,
  p_monthly_late_early_used int,
  p_monthly_leave_credits_used numeric,
  p_manual_late boolean default false
) returns day_evaluation
language plpgsql
stable
as $$
declare
  shift_start constant int := 570;             -- 09:30
  shift_end constant int := 1110;              -- 18:30
  early_min constant int := 1020;              -- 17:00
  half_day_out_min constant int := 840;        -- 14:00
  half_day_in_max constant int := 840;         -- 14:00 (HALF_DAY_IN_MAX_HOUR * 60)
  on_time_max constant int := 6;
  late_max constant int := 90;
  monthly_leave_credits constant numeric := 1;
  monthly_late_early_free constant int := 3;

  v_in_minutes int := case when p_first_in is null then null else extract(hour from p_first_in)::int * 60 + extract(minute from p_first_in)::int end;
  v_out_minutes int := case when p_last_out is null then null else extract(hour from p_last_out)::int * 60 + extract(minute from p_last_out)::int end;

  v_in_status text := 'absent';
  v_out_status text := 'absent';
  v_mins_late int;

  v_late_flag boolean;
  v_early_flag boolean;
  v_half_day_flag boolean;

  v_new_late_early_used int;
  v_new_credits_used numeric := coalesce(p_monthly_leave_credits_used, 0);
  v_credit_delta numeric := 0;
  v_late_early_delta int := 0;
  v_notes text[] := '{}';
  v_status text := 'Present';

  v_absent day_evaluation;
  v_result day_evaluation;
begin
  -- Classify Punch IN
  if v_in_minutes is not null then
    v_mins_late := v_in_minutes - shift_start;
    if v_mins_late <= on_time_max then
      v_in_status := 'ontime';
    elsif v_mins_late <= late_max then
      v_in_status := 'late';
    elsif v_in_minutes < half_day_in_max then
      v_in_status := 'halfday';
    else
      v_in_status := 'absent';
    end if;
  end if;

  -- Admin override: an on-time IN marked late by admin becomes 'late' here,
  -- so every consequence below (Case 2 allowance + escalation) is identical
  -- to a system-detected late.
  if p_manual_late and v_in_status = 'ontime' then
    v_in_status := 'late';
    v_notes := array_append(v_notes, 'Marked late by admin');
  end if;

  -- Classify Punch OUT (C-1: if IN already halfday, OUT's absent bucket is suppressed)
  if v_out_minutes is not null then
    if v_out_minutes >= shift_end then
      v_out_status := 'ontime';
    elsif v_out_minutes >= early_min then
      v_out_status := 'early';
    elsif v_out_minutes >= half_day_out_min then
      v_out_status := 'halfday';
    elsif v_in_status = 'halfday' then
      v_out_status := 'halfday';
    else
      v_out_status := 'absent';
    end if;
  end if;

  -- IN absent (>= 2PM or missing... but missing IN can't reach here, see evaluate_day step 4.5) -> full absent, times preserved
  if v_in_status = 'absent' then
    v_absent := evaluate_absent('Fixed', p_monthly_leave_credits_used);
    v_absent.in_time := p_first_in;
    v_absent.out_time := p_last_out;
    return v_absent;
  end if;

  -- OUT absent -> absent, UNLESS IN was already halfday (C-1)
  if v_out_status = 'absent' then
    if v_in_status <> 'halfday' then
      v_absent := evaluate_absent('Fixed', p_monthly_leave_credits_used);
      v_absent.in_time := p_first_in;
      v_absent.out_time := p_last_out;
      return v_absent;
    end if;
    v_out_status := 'halfday';
  end if;

  v_late_flag := (v_in_status = 'late');
  v_early_flag := (v_out_status = 'early');
  v_half_day_flag := (v_in_status = 'halfday' or v_out_status = 'halfday');
  v_new_late_early_used := coalesce(p_monthly_late_early_used, 0);

  -- Case 1: Half Day (from IN or OUT bucket)
  if v_half_day_flag then
    v_status := 'Half Day';
    if v_in_status = 'halfday' then
      v_notes := array_append(v_notes, 'Late IN (' || minutes_to_hhmm(v_in_minutes) || ')');
    end if;
    if v_out_status = 'halfday' then
      v_notes := array_append(v_notes, 'Early OUT (' || minutes_to_hhmm(v_out_minutes) || ')');
    end if;
    if v_new_credits_used < monthly_leave_credits then
      v_credit_delta := 0.5;
      v_notes := array_append(v_notes, '0.5 leave credit used');
    else
      v_notes := array_append(v_notes, 'No leave credits — penalty half day');
    end if;

  -- Case 2: Late IN (not half day)
  elsif v_late_flag then
    v_late_early_delta := 1;
    v_new_late_early_used := v_new_late_early_used + 1;
    v_notes := array_append(v_notes, 'Late IN (' || minutes_to_hhmm(v_in_minutes) || ')');
    if v_new_late_early_used > monthly_late_early_free then
      -- C-2: unconditional 0.5 deduction, no remaining-credit guard (unlike Case 1)
      v_half_day_flag := true;
      v_status := 'Half Day';
      v_credit_delta := 0.5;
      v_notes := array_append(v_notes, format('Penalty: %sth late/early this month → half day', v_new_late_early_used));
    else
      v_notes := array_append(v_notes, format('Late/early %s/%s free used', v_new_late_early_used, monthly_late_early_free));
    end if;

  -- Case 3: Early OUT (not half day)
  elsif v_early_flag then
    v_late_early_delta := 1;
    v_new_late_early_used := v_new_late_early_used + 1;
    v_notes := array_append(v_notes, 'Early OUT (' || minutes_to_hhmm(v_out_minutes) || ')');
    if v_new_late_early_used > monthly_late_early_free then
      v_half_day_flag := true;
      v_status := 'Half Day';
      v_credit_delta := 0.5;
      v_notes := array_append(v_notes, format('Penalty: %sth late/early this month → half day', v_new_late_early_used));
    else
      v_notes := array_append(v_notes, format('Late/early %s/%s free used', v_new_late_early_used, monthly_late_early_free));
    end if;
  end if;

  -- Case 4 (C-3): both late IN and early OUT, same day, and NOT already converted to
  -- Half Day above -> reported delta becomes 2, but the threshold decision in Case 2
  -- already ran using only +1. This drift is intentional -- see Appendix C-3.
  if v_late_flag and v_early_flag and not v_half_day_flag then
    v_late_early_delta := 2;
  end if;

  v_result.status := v_status;
  v_result.in_time := p_first_in;
  v_result.out_time := p_last_out;
  v_result.late_flag := v_late_flag;
  v_result.early_flag := v_early_flag;
  v_result.half_day_flag := v_half_day_flag;
  v_result.working_sunday := false;
  v_result.leave_credit_used := v_credit_delta;
  v_result.late_early_delta := v_late_early_delta;
  v_result.notes := array_to_string(v_notes, '; ');
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. evaluate_day: pass-through, plus the Punch-In-Only branch surfaces the
--    mark immediately (late_flag counts on the dashboard and in the running
--    counters even before the employee punches OUT).
-- ---------------------------------------------------------------------------
drop function evaluate_day(employee_type, date, boolean, time, time, boolean, text, int, numeric);

create function evaluate_day(
  p_employee_type employee_type,
  p_date date,
  p_has_any_punch boolean,
  p_first_in time,
  p_last_out time,
  p_is_holiday boolean,
  p_holiday_name text,
  p_monthly_late_early_used int default 0,
  p_monthly_leave_credits_used numeric default 0,
  p_manual_late boolean default false
) returns day_evaluation
language plpgsql
stable
as $$
declare
  v_result day_evaluation;
  v_is_weekly_off boolean := extract(dow from p_date) = 0; -- CONFIG.WEEKLY_OFF_DAYS = [0] (Sunday)
begin
  -- STEP 1: public holiday
  if p_is_holiday then
    if p_has_any_punch then
      v_result.status := 'Working Holiday';
      v_result.in_time := p_first_in;
      v_result.out_time := p_last_out;
      v_result.late_flag := false;
      v_result.early_flag := false;
      v_result.half_day_flag := false;
      v_result.working_sunday := false;
      v_result.leave_credit_used := 0;
      v_result.late_early_delta := 0;
      v_result.notes := 'Worked on Holiday: ' || coalesce(p_holiday_name, '');
    else
      v_result.status := 'Holiday';
      v_result.late_flag := false;
      v_result.early_flag := false;
      v_result.half_day_flag := false;
      v_result.working_sunday := false;
      v_result.leave_credit_used := 0;
      v_result.late_early_delta := 0;
      v_result.notes := 'Public Holiday: ' || coalesce(p_holiday_name, '');
    end if;
    return v_result;
  end if;

  -- STEP 2/3: Sunday
  if v_is_weekly_off then
    if p_has_any_punch then
      v_result.status := 'Working Sunday';
      v_result.in_time := p_first_in;
      v_result.out_time := p_last_out;
      v_result.late_flag := false;
      v_result.early_flag := false;
      v_result.half_day_flag := false;
      v_result.working_sunday := true;
      v_result.leave_credit_used := 0;
      v_result.late_early_delta := 0;
      v_result.notes := 'Working Sunday';
    else
      v_result.status := 'Weekly Off';
      v_result.late_flag := false;
      v_result.early_flag := false;
      v_result.half_day_flag := false;
      v_result.working_sunday := false;
      v_result.leave_credit_used := 0;
      v_result.late_early_delta := 0;
      v_result.notes := 'Weekly Off';
    end if;
    return v_result;
  end if;

  -- STEP 4: no punch on a working day
  if not p_has_any_punch then
    return evaluate_absent(p_employee_type, p_monthly_leave_credits_used);
  end if;

  -- STEP 4.5: IN but no OUT
  if p_first_in is not null and p_last_out is null then
    v_result.status := 'Punch In Only';
    v_result.in_time := p_first_in;
    v_result.late_flag := p_manual_late;
    v_result.early_flag := false;
    v_result.half_day_flag := false;
    v_result.working_sunday := false;
    v_result.leave_credit_used := 0;
    v_result.late_early_delta := 0;
    v_result.notes := 'Punch In Only — no Punch OUT recorded. Not counted as a working day.'
      || case when p_manual_late then ' Marked late by admin.' else '' end;
    return v_result;
  end if;

  -- STEP 5/6: type-specific policy
  if p_employee_type = 'Probation' then
    return evaluate_probation(p_first_in, p_last_out, p_manual_late);
  end if;

  return evaluate_fixed(p_first_in, p_last_out, p_monthly_late_early_used, p_monthly_leave_credits_used, p_manual_late);
end;
$$;

grant execute on function evaluate_probation(time, time, boolean) to authenticated;
grant execute on function evaluate_fixed(time, time, int, numeric, boolean) to authenticated;
grant execute on function evaluate_day(employee_type, date, boolean, time, time, boolean, text, int, numeric, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. reevaluate_attendance_day: one day's aggregation + evaluation + upsert,
--    factored out of record_punch step 6 so admin_mark_late can reuse it.
--    Reads the row's own manual_late, so any caller reproduces the mark.
--    Internal only -- reachable through the SECURITY DEFINER RPCs, not
--    callable by clients directly.
-- ---------------------------------------------------------------------------
create function reevaluate_attendance_day(
  p_emp_id text,
  p_day date
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  tz constant text := 'Asia/Kolkata';
  v_emp employees%rowtype;
  v_has_any_punch boolean;
  v_first_in time;
  v_last_out time;
  v_holiday_name text;
  v_is_holiday boolean;
  v_manual_late boolean;
  v_counters record;
  v_eval day_evaluation;
begin
  select * into v_emp from employees where emp_id = p_emp_id;
  if not found then
    return;
  end if;

  select
    count(*) > 0,
    (min(punched_at) filter (where action = 'IN')) at time zone tz,
    (max(punched_at) filter (where action = 'OUT')) at time zone tz
  into v_has_any_punch, v_first_in, v_last_out
  from punch_logs
  where emp_id = p_emp_id
    and punched_at >= (p_day::timestamp at time zone tz)
    and punched_at < ((p_day + 1)::timestamp at time zone tz);

  select (date is not null), holiday_name into v_is_holiday, v_holiday_name
  from holidays where date = p_day;
  v_is_holiday := coalesce(v_is_holiday, false);

  select manual_late into v_manual_late
  from attendance_summary where emp_id = p_emp_id and date = p_day;

  select * into v_counters from compute_monthly_counters(p_emp_id, p_day);

  v_eval := evaluate_day(
    v_emp.employee_type, p_day, v_has_any_punch, v_first_in, v_last_out,
    v_is_holiday, v_holiday_name,
    coalesce(v_counters.late_early_used, 0), coalesce(v_counters.leave_credits_used, 0),
    coalesce(v_manual_late, false)
  );

  if v_eval.status is null then
    return;
  end if;

  insert into attendance_summary (
    emp_id, date, in_time, out_time, status, late_flag, early_flag,
    half_day_flag, working_sunday, leave_credit_used, notes
  ) values (
    p_emp_id, p_day, v_eval.in_time, v_eval.out_time, v_eval.status,
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
end;
$$;

-- Not for clients: default PUBLIC execute is revoked and no grant is added.
revoke execute on function reevaluate_attendance_day(text, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. admin_mark_late: the dashboard quick action.
-- ---------------------------------------------------------------------------
create function admin_mark_late(
  p_emp_id text,
  p_date date,
  p_late boolean,
  p_note text default null
) returns table (
  success boolean,
  message text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  tz constant text := 'Asia/Kolkata';
  v_today date := (now() at time zone tz)::date;
  v_row attendance_summary%rowtype;
  v_status text;
  v_d date;
begin
  if not is_admin() then
    raise exception 'Admin access only.' using errcode = '42501';
  end if;

  -- Same lock key as record_punch: a concurrent punch-out for this employee
  -- and this mark serialize instead of racing on the same summary row.
  perform pg_advisory_xact_lock(hashtext(p_emp_id));

  if p_date > v_today then
    return query select false, 'Cannot mark a future date.'::text;
    return;
  end if;
  if extract(dow from p_date) = 0 then
    return query select false, 'Late marking applies to working days only (this is a Sunday).'::text;
    return;
  end if;
  if exists (select 1 from holidays where date = p_date) then
    return query select false, 'Late marking applies to working days only (this is a holiday).'::text;
    return;
  end if;

  select * into v_row from attendance_summary
  where emp_id = p_emp_id and date = p_date;
  if not found or v_row.in_time is null then
    return query select false, 'Employee has no Punch IN on this date.'::text;
    return;
  end if;

  update attendance_summary set
    manual_late      = p_late,
    manual_late_note = case when p_late then nullif(trim(p_note), '') end,
    manual_late_by   = case when p_late then (auth.jwt() ->> 'email') end,
    manual_late_at   = case when p_late then now() end
  where emp_id = p_emp_id and date = p_date;

  -- Apply the consequences to the marked day itself...
  perform reevaluate_attendance_day(p_emp_id, p_date);

  -- ...and ripple through the rest of the month: the running late/early
  -- counter changed, which can flip a LATER day's 4th-late -> Half Day
  -- conversion. No scheduled job re-evaluates existing rows, so do it here.
  -- Marking today (the common dashboard case) loops zero times.
  for v_d in
    select date from attendance_summary
    where emp_id = p_emp_id
      and date > p_date
      and date <= least((date_trunc('month', p_date) + interval '1 month - 1 day')::date, v_today)
    order by date
  loop
    perform reevaluate_attendance_day(p_emp_id, v_d);
  end loop;

  select status into v_status from attendance_summary
  where emp_id = p_emp_id and date = p_date;

  return query select true,
    case when p_late
      then format('Marked late — day is now "%s".', v_status)
      else format('Late mark removed — day is now "%s".', v_status)
    end;
end;
$$;

grant execute on function admin_mark_late(text, date, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. record_punch: same 7-param signature as 20260719000000, now feeding the
--    day's manual_late into evaluate_day so a punch-out after an admin mark
--    re-applies the late consequences instead of clobbering them.
-- ---------------------------------------------------------------------------
create or replace function record_punch(
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
  v_manual_late boolean;
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

  -- 6. Re-evaluate today's attendance_summary row (IST calendar day),
  --    carrying forward any admin manual-late mark on the existing row.
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

  select manual_late into v_manual_late
  from attendance_summary where emp_id = v_emp.emp_id and date = v_today;

  select * into v_counters from compute_monthly_counters(v_emp.emp_id, v_today);

  v_eval := evaluate_day(
    v_emp.employee_type, v_today, v_has_any_punch, v_first_in, v_last_out,
    v_is_holiday, v_holiday_name,
    coalesce(v_counters.late_early_used, 0), coalesce(v_counters.leave_credits_used, 0),
    coalesce(v_manual_late, false)
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
