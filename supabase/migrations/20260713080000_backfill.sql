-- Phase 3, Task 6: backfill_missing_days() -- catch-up for past days that
-- never got an attendance_summary row (new hire mid-month, nightly trigger
-- missed them, etc).
-- Ported from legacy-apps-script/attendanceengine.gs (Attendance_backfillMissingDays).
--
-- COUNTER SEQUENCING (the reason this can't reuse compute_monthly_counters()):
-- compute_monthly_counters() (Task 5) sums late_flag/early_flag booleans
-- already sitting in attendance_summary -- correct for the live-punch path,
-- where every prior day in the month already has a row. Backfill is the one
-- case where that's NOT true: several days in the same run are being
-- created one after another, and each new day's evaluate_day() call must
-- see the counters AS THEY STOOD after the previous day in this loop, not
-- after the whole month. The legacy code carries this in an in-memory
-- counters object, incrementing it by late_early_delta (not by re-summing
-- flags) after each day. We do the same here with plpgsql variables.
--
-- Seeding: exactly like the legacy code, the starting counters are summed
-- from ALL attendance_summary rows already in the month -- regardless of
-- whether they fall before or after the gaps being filled. That is a
-- faithful port of the original's behaviour, not a bug we're introducing;
-- see .claude/plan.md Appendix C / progress log for the C-3 mechanism note.
create or replace function backfill_missing_days(
  p_emp_id text,
  p_month  date -- any day within the target month; only year+month are used
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  tz constant text := 'Asia/Kolkata';
  v_emp employees%rowtype;
  v_today date;
  v_month_start date;
  v_month_end date;
  v_last_day date;
  v_late_early_used int;
  v_leave_credits_used numeric;
  v_d date;
  v_has_any_punch boolean;
  v_first_in time;
  v_last_out time;
  v_is_holiday boolean;
  v_holiday_name text;
  v_eval day_evaluation;
  v_inserted int := 0;
begin
  if not (is_admin() or p_emp_id = current_employee_id()) then
    raise exception 'not authorized to backfill this employee' using errcode = '42501';
  end if;

  select * into v_emp from employees where emp_id = p_emp_id;
  if not found then
    raise exception 'employee % not found', p_emp_id;
  end if;

  v_today       := (now() at time zone tz)::date;
  v_month_start := date_trunc('month', p_month)::date;
  v_month_end   := (v_month_start + interval '1 month - 1 day')::date;
  -- never process today or the future -- stop the walk the day before today
  v_last_day    := least(v_month_end, v_today - 1);

  -- Seed running counters from whatever already exists in this month.
  select
    coalesce(sum((late_flag)::int), 0) + coalesce(sum((early_flag)::int), 0),
    coalesce(sum(leave_credit_used), 0)
  into v_late_early_used, v_leave_credits_used
  from attendance_summary
  where emp_id = p_emp_id
    and date >= v_month_start
    and date <= v_month_end;

  v_d := v_month_start;
  while v_d <= v_last_day loop
    if exists (select 1 from attendance_summary where emp_id = p_emp_id and date = v_d) then
      v_d := v_d + 1;
      continue;
    end if;

    select
      count(*) > 0,
      (min(punched_at) filter (where action = 'IN')) at time zone tz,
      (max(punched_at) filter (where action = 'OUT')) at time zone tz
    into v_has_any_punch, v_first_in, v_last_out
    from punch_logs
    where emp_id = p_emp_id
      and punched_at >= (v_d::timestamp at time zone tz)
      and punched_at < ((v_d + 1)::timestamp at time zone tz);

    select (date is not null), holiday_name into v_is_holiday, v_holiday_name
    from holidays where date = v_d;
    v_is_holiday := coalesce(v_is_holiday, false);

    v_eval := evaluate_day(
      v_emp.employee_type, v_d, v_has_any_punch, v_first_in, v_last_out,
      v_is_holiday, v_holiday_name,
      coalesce(v_late_early_used, 0), coalesce(v_leave_credits_used, 0)
    );

    if v_eval.status is not null then
      insert into attendance_summary (
        emp_id, date, in_time, out_time, status, late_flag, early_flag,
        half_day_flag, working_sunday, leave_credit_used, notes
      ) values (
        p_emp_id, v_d, v_eval.in_time, v_eval.out_time, v_eval.status,
        v_eval.late_flag, v_eval.early_flag, v_eval.half_day_flag,
        v_eval.working_sunday, v_eval.leave_credit_used, v_eval.notes
      );
      v_inserted := v_inserted + 1;

      v_leave_credits_used := v_leave_credits_used + coalesce(v_eval.leave_credit_used, 0);
      v_late_early_used    := v_late_early_used + coalesce(v_eval.late_early_delta, 0);
    end if;

    v_d := v_d + 1;
  end loop;

  return v_inserted;
end;
$$;

grant execute on function backfill_missing_days(text, date) to authenticated;
