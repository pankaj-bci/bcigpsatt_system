-- Phase 3: policy engine (per-day attendance evaluation).
-- Ported from legacy-apps-script/policyengine.gs (Policy_evaluateDay +
-- Policy_evaluateAbsent/Probation/Fixed), function-for-function, preserving
-- every quirk in .claude/plan.md Appendix C (C-1..C-7) exactly -- this is
-- the highest-value module for payroll parity (Section 9 / O6).
--
-- Design note: the old code took a full punchLogs array and re-derived
-- "first IN" / "last OUT" internally (_firstPunch/_lastPunch, C-7). Here the
-- caller (record_punch(), backfill, nightly job) is responsible for
-- pre-aggregating punch_logs into (has_any_punch, first_in, last_out) via
-- min(punched_at) filter (where action='IN') / max(...) filter (where
-- action='OUT') for the day -- same chronological-first/last semantics,
-- computed once instead of duplicated in every caller.
--
-- Design note 2: the old JS had defensive "employee is undefined" guards
-- because a spreadsheet row could be malformed. Postgres FK constraints
-- make that class of input impossible here, so those guards are omitted --
-- this changes no output for any input that could actually occur.

create type day_evaluation as (
  status             text,
  in_time            time,
  out_time           time,
  late_flag          boolean,
  early_flag         boolean,
  half_day_flag      boolean,
  working_sunday     boolean,
  leave_credit_used  numeric(3,1),
  late_early_delta   smallint,
  notes              text
);

-- Matches _minutesToStr(): minutes-from-midnight -> "HH:MM".
create or replace function minutes_to_hhmm(mins int)
returns text
language sql
immutable
parallel safe
as $$
  select case when mins is null then '--:--'
    else lpad((mins / 60)::text, 2, '0') || ':' || lpad((mins % 60)::text, 2, '0')
  end;
$$;

-- Matches Policy_evaluateAbsent(): working day, no valid IN/OUT pair.
create or replace function evaluate_absent(
  p_employee_type employee_type,
  p_monthly_leave_credits_used numeric
) returns day_evaluation
language plpgsql
stable
as $$
declare
  v_result day_evaluation;
  v_credits_used numeric := coalesce(p_monthly_leave_credits_used, 0);
  v_credit_limit constant numeric := 1; -- CONFIG.FIXED.MONTHLY_LEAVE_CREDITS
begin
  v_result.in_time := null;
  v_result.out_time := null;
  v_result.late_flag := false;
  v_result.early_flag := false;
  v_result.half_day_flag := false;
  v_result.working_sunday := false;

  if p_employee_type = 'Probation' then
    v_result.status := 'Unpaid Absent';
    v_result.leave_credit_used := 0;
    v_result.late_early_delta := 0;
    v_result.notes := 'Probation: No punch — Unpaid Absent';
    return v_result;
  end if;

  if v_credits_used < v_credit_limit then
    v_result.status := 'Absent';
    v_result.leave_credit_used := 1;
    v_result.late_early_delta := 0;
    v_result.notes := format('Absent — 1 leave credit used (%s/%s this month)', v_credits_used + 1, v_credit_limit);
    return v_result;
  end if;

  v_result.status := 'Unpaid Absent';
  v_result.leave_credit_used := 0;
  v_result.late_early_delta := 0;
  v_result.notes := 'Absent — No leave credits remaining. Unpaid.';
  return v_result;
end;
$$;

-- Matches Policy_evaluateProbation(): zero-tolerance, either violation = Half Day.
create or replace function evaluate_probation(
  p_first_in time,
  p_last_out time
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
  v_late_violation boolean := (v_in_minutes is null or v_in_minutes > late_limit);
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

-- Matches Policy_evaluateFixed(): time buckets + monthly allowance logic.
-- The Case 1/2/3/4 comments below mirror the original's comments exactly --
-- see .claude/plan.md Appendix C-1, C-2, C-3 for why the mutation order here
-- is load-bearing, not incidental style.
create or replace function evaluate_fixed(
  p_first_in time,
  p_last_out time,
  p_monthly_late_early_used int,
  p_monthly_leave_credits_used numeric
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

-- Matches Policy_evaluateDay(): master dispatcher, short-circuits in this exact order.
create or replace function evaluate_day(
  p_employee_type employee_type,
  p_date date,
  p_has_any_punch boolean,
  p_first_in time,
  p_last_out time,
  p_is_holiday boolean,
  p_holiday_name text,
  p_monthly_late_early_used int default 0,
  p_monthly_leave_credits_used numeric default 0
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
    v_result.late_flag := false;
    v_result.early_flag := false;
    v_result.half_day_flag := false;
    v_result.working_sunday := false;
    v_result.leave_credit_used := 0;
    v_result.late_early_delta := 0;
    v_result.notes := 'Punch In Only — no Punch OUT recorded. Not counted as a working day.';
    return v_result;
  end if;

  -- STEP 5/6: type-specific policy
  if p_employee_type = 'Probation' then
    return evaluate_probation(p_first_in, p_last_out);
  end if;

  return evaluate_fixed(p_first_in, p_last_out, p_monthly_late_early_used, p_monthly_leave_credits_used);
end;
$$;

grant execute on function minutes_to_hhmm(int) to authenticated;
grant execute on function evaluate_absent(employee_type, numeric) to authenticated;
grant execute on function evaluate_probation(time, time) to authenticated;
grant execute on function evaluate_fixed(time, time, int, numeric) to authenticated;
grant execute on function evaluate_day(employee_type, date, boolean, time, time, boolean, text, int, numeric) to authenticated;
