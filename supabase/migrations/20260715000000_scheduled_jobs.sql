-- Phase 5, Task 1: pg_cron scheduled jobs (nightly recompute + monthly
-- finalize), replacing the legacy Apps Script time-triggers
-- (Attendance_runDailyTrigger 23:00, Report_runMonthlyTrigger 1st @ 01:00 --
-- see .claude/plan.md Section 5.1 item 9 and Section 11 table). Contributes
-- to O9.
--
-- WHY THE AUTH GUARDS ON backfill_missing_days() / generate_monthly_summary()
-- NEED TO CHANGE: both were written in Phase 3 for PostgREST callers only,
-- gated on `is_admin() or p_emp_id = current_employee_id()` -- which reads
-- auth.jwt() (the caller's JWT claims). A pg_cron job runs as a plain
-- Postgres role with NO PostgREST request context, so auth.jwt() reads an
-- unset GUC and returns null; the old guard would reject every cron call.
-- Fix: only enforce the ownership check when a JWT is actually present (a
-- real PostgREST caller, authenticated or anon-with-forged-claims still
-- gets the exact same check as before). A null JWT only happens for
-- server-internal callers (cron, or another SECURITY DEFINER function) --
-- there is no code path where an external HTTP request reaches Postgres
-- without PostgREST attaching a JWT, forged or not. Re-declared here via
-- CREATE OR REPLACE rather than editing the Phase 3 files, so the parity
-- suite's history stays intact; bodies are otherwise byte-identical to
-- 20260713080000_backfill.sql / 20260713100000_monthly_rollup.sql.

create or replace function backfill_missing_days(
  p_emp_id text,
  p_month  date
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
  if auth.jwt() is not null and not (is_admin() or p_emp_id = current_employee_id()) then
    raise exception 'not authorized to backfill this employee' using errcode = '42501';
  end if;

  select * into v_emp from employees where emp_id = p_emp_id;
  if not found then
    raise exception 'employee % not found', p_emp_id;
  end if;

  v_today       := (now() at time zone tz)::date;
  v_month_start := date_trunc('month', p_month)::date;
  v_month_end   := (v_month_start + interval '1 month - 1 day')::date;
  v_last_day    := least(v_month_end, v_today - 1);

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

create or replace function generate_monthly_summary(
  p_emp_id text,
  p_month  date
) returns monthly_summary
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month_start date := date_trunc('month', p_month)::date;
  v_month_end date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  v_month_text text := to_char(p_month, 'YYYY-MM');
  v_working_days int;
  v_row monthly_summary%rowtype;
begin
  if auth.jwt() is not null and not (is_admin() or p_emp_id = current_employee_id()) then
    raise exception 'not authorized to generate this employee''s monthly summary' using errcode = '42501';
  end if;

  if not exists (select 1 from employees where emp_id = p_emp_id) then
    raise exception 'employee % not found', p_emp_id;
  end if;

  v_working_days := count_working_days(p_month);

  select
    p_emp_id,
    v_month_text,
    v_working_days,
    count(*) filter (where status in ('Present', 'Working Sunday', 'Half Day')),
    count(*) filter (where late_flag),
    count(*) filter (where early_flag),
    count(*) filter (where status = 'Half Day'),
    count(*) filter (where status in ('Absent', 'Unpaid Absent')),
    count(*) filter (where status = 'Unpaid Absent'),
    coalesce(sum(leave_credit_used), 0),
    count(*) filter (where status = 'Working Sunday'),
    count(*) filter (where late_flag or early_flag),
    coalesce(sum(leave_credit_used), 0)
  into
    v_row.emp_id, v_row.month, v_row.working_days, v_row.total_present,
    v_row.total_late, v_row.total_early, v_row.total_half_days,
    v_row.total_absent, v_row.total_unpaid_absent, v_row.total_leaves_used,
    v_row.total_working_sundays, v_row.late_early_used, v_row.leave_credits_used
  from attendance_summary
  where emp_id = p_emp_id
    and date >= v_month_start
    and date <= v_month_end;

  insert into monthly_summary (
    emp_id, month, working_days, total_present, total_late, total_early,
    total_half_days, total_absent, total_unpaid_absent, total_leaves_used,
    total_working_sundays, late_early_used, leave_credits_used
  ) values (
    v_row.emp_id, v_row.month, v_row.working_days, v_row.total_present,
    v_row.total_late, v_row.total_early, v_row.total_half_days,
    v_row.total_absent, v_row.total_unpaid_absent, v_row.total_leaves_used,
    v_row.total_working_sundays, v_row.late_early_used, v_row.leave_credits_used
  )
  on conflict (emp_id, month) do update set
    working_days = excluded.working_days,
    total_present = excluded.total_present,
    total_late = excluded.total_late,
    total_early = excluded.total_early,
    total_half_days = excluded.total_half_days,
    total_absent = excluded.total_absent,
    total_unpaid_absent = excluded.total_unpaid_absent,
    total_leaves_used = excluded.total_leaves_used,
    total_working_sundays = excluded.total_working_sundays,
    late_early_used = excluded.late_early_used,
    leave_credits_used = excluded.leave_credits_used
  returning * into v_row;

  return v_row;
end;
$$;

-- Nightly job body: for every employee, catch up (backfill) yesterday --
-- and, as a side effect of backfill_missing_days' month-start-to-yesterday
-- walk, any other day this month that's still missing a row. Passing
-- "yesterday" (not "today") as p_month is what makes this correct across a
-- month boundary: on the 1st, yesterday is the last day of the PREVIOUS
-- month, so the function's own date_trunc(p_month) naturally targets that
-- month instead of the new one.
create or replace function run_daily_recompute() returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_yesterday constant date := (now() at time zone 'Asia/Kolkata')::date - 1;
  v_emp record;
begin
  for v_emp in select emp_id from employees loop
    perform backfill_missing_days(v_emp.emp_id, v_yesterday);
  end loop;
end;
$$;

-- Monthly job body: pg_cron has no "last day of month" schedule, so this is
-- scheduled to fire DAILY (see cron.schedule below) and no-ops on every day
-- except the 1st (Asia/Kolkata) -- the same self-guard trick used for the
-- "day before 1st" problem instead of trying to express it in five cron
-- fields. On the 1st, it finalizes the month that just ended (yesterday's
-- month) for every employee.
create or replace function run_monthly_finalize() returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today constant date := (now() at time zone 'Asia/Kolkata')::date;
  v_prev_month constant date := v_today - 1;
  v_emp record;
begin
  if extract(day from v_today) <> 1 then
    return;
  end if;

  for v_emp in select emp_id from employees loop
    perform generate_monthly_summary(v_emp.emp_id, v_prev_month);
  end loop;
end;
$$;

-- pg_cron runs on the DB server's clock, which on Supabase is UTC.
-- Asia/Kolkata is UTC+5:30 with no DST, so the offset is fixed year-round:
--   23:00 IST = 17:30 UTC            -> nightly recompute
--   01:00 IST (on the 1st) = 19:30 UTC on the day BEFORE the 1st -> monthly
-- The monthly job is therefore scheduled daily at 19:30 UTC and relies on
-- run_monthly_finalize()'s own day-of-month guard (see above), not on the
-- cron day-of-month field, to only act once a month.
create extension if not exists pg_cron with schema extensions;

select cron.schedule(
  'nightly-recompute',
  '30 17 * * *',
  $$select run_daily_recompute();$$
);

select cron.schedule(
  'monthly-finalize',
  '30 19 * * *',
  $$select run_monthly_finalize();$$
);
