-- Phase 3, Task 8: monthly rollup -- count_working_days() +
-- generate_monthly_summary() (+ an admin-only all-employees wrapper).
-- Ported from legacy-apps-script/attendanceengine.gs
-- (Report_countWorkingDays, Report_generateMonthlySummary).
--
-- IMPORTANT divergence from Task 5's compute_monthly_counters(), confirmed
-- by reading the legacy source rather than assumed: this rollup's
-- `late_early_used` is a COUNT OF DAYS where late_flag OR early_flag is
-- true (0 or 1 per day). Task 5's live-punch counter is a SUM of the two
-- booleans separately (0, 1, or 2 per day -- a same-day late+early counts
-- twice). These are two different numbers computed two different ways in
-- the original system, used for two different purposes (Task 5 gates the
-- next punch's threshold check mid-month; this one is a finished-month
-- display rollup) -- faithfully kept distinct here, not unified.
create or replace function count_working_days(
  p_month date -- any day within the target month
) returns int
language sql
stable
as $$
  select count(*)::int
  from generate_series(
    date_trunc('month', p_month)::date,
    (date_trunc('month', p_month) + interval '1 month - 1 day')::date,
    interval '1 day'
  ) as gs(d)
  where extract(dow from gs.d) <> 0                          -- Sunday only (CONFIG.WEEKLY_OFF_DAYS = [0])
    and not exists (select 1 from holidays h where h.date = gs.d::date);
$$;

grant execute on function count_working_days(date) to authenticated;

-- Single-employee rollup. security definer: monthly_summary has no staff
-- insert/update policy at all (RLS comment: "computed server-side"), same
-- as attendance_summary in Task 6 -- so even generating your OWN month
-- needs to run as the function owner. Authorized for self or is_admin(),
-- same pattern as backfill_missing_days().
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
  if not (is_admin() or p_emp_id = current_employee_id()) then
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

grant execute on function generate_monthly_summary(text, date) to authenticated;

-- All-employees wrapper (the "no empId" branch of Report_generateMonthlySummary),
-- for the monthly cron trigger / an admin's "regenerate all" action. Admin-only.
create or replace function generate_monthly_summary_all(
  p_month date
) returns setof monthly_summary
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emp record;
begin
  if not is_admin() then
    raise exception 'admin access only' using errcode = '42501';
  end if;

  for v_emp in select emp_id from employees loop
    return next generate_monthly_summary(v_emp.emp_id, p_month);
  end loop;
end;
$$;

grant execute on function generate_monthly_summary_all(date) to authenticated;
