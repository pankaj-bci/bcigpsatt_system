-- Phase 3: running monthly counters (live-punch path).
-- Ported from legacy-apps-script/attendanceengine.gs (_computeCountersFromDailies).
-- Deliberately reads from attendance_summary (per-day records), NOT from
-- monthly_summary -- the old code's comment explains why: monthly_summary
-- is only refreshed at month-end, so reading it mid-month would give zero
-- counters for every day and cause every absence to wrongly deduct a
-- credit. See .claude/plan.md Appendix C-6 and the Phase 3 progress log
-- entry on the C-3 mechanism correction (2026-07-13) for why this function
-- sums late_flag/early_flag booleans rather than any late_early_delta value
-- -- that field is a backfill-only concern (Task 6), not used here.
create or replace function compute_monthly_counters(
  p_emp_id text,
  p_before_date date -- exclusive: sums all days strictly before this date, same calendar month
) returns table (
  late_early_used int,
  leave_credits_used numeric
)
language sql
stable
as $$
  select
    coalesce(sum((late_flag)::int), 0) + coalesce(sum((early_flag)::int), 0) as late_early_used,
    coalesce(sum(leave_credit_used), 0) as leave_credits_used
  from attendance_summary
  where emp_id = p_emp_id
    and date >= date_trunc('month', p_before_date)::date
    and date < p_before_date;
$$;

grant execute on function compute_monthly_counters(text, date) to authenticated;
