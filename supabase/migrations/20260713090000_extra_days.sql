-- Phase 3, Task 7: get_extra_days_yearly() -- extra days earned across a
-- full calendar year for working on an off day (Sunday or public holiday).
-- Ported from legacy-apps-script/attendanceengine.gs (Attendance_getExtraDaysYearly).
--
-- Rules (confirmed by org, unchanged from legacy):
--   duration >= 4 hrs        -> +1   extra day
--   duration <  4 hrs        -> +0.5 extra day
--   OUT punch missing (IN present) -> +1   extra day (still showed up)
--   IN punch missing (OUT present) -> +0.5 (shouldn't happen, legacy keeps it safe)
--   neither IN nor OUT present     -> +0  (skip)
--
-- Computed on the fly from attendance_summary -- no extra column, matching
-- the legacy "no schema migration" approach. Deliberately plain SQL with
-- invoker rights (no security definer): attendance_summary's existing RLS
-- policies (self row, or is_admin()) already give exactly the right
-- visibility for this read, so there's nothing extra to bypass.
create or replace function get_extra_days_yearly(
  p_emp_id text,
  p_year   int
) returns numeric
language sql
stable
as $$
  select coalesce(sum(
    case
      when in_time is null and out_time is null then 0
      when out_time is null then 1                                         -- missing OUT, has IN -> full day
      when in_time is null then 0.5                                        -- missing IN, has OUT
      when extract(epoch from (out_time - in_time)) / 60 >= 240 then 1     -- >= 4 hrs
      else 0.5                                                             -- < 4 hrs
    end
  ), 0)
  from attendance_summary
  where emp_id = p_emp_id
    and extract(year from date)::int = p_year
    and status in ('Working Sunday', 'Working Holiday');
$$;

grant execute on function get_extra_days_yearly(text, int) to authenticated;
