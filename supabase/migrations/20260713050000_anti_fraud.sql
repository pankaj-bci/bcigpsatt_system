-- Phase 3: anti-fraud validation for punches.
-- Ported from legacy-apps-script/attendanceengine.gs (Attendance_validateAntiFraud).
-- Day-scoped by design (see source comments): every calendar day starts
-- fresh, so a forgotten OUT from yesterday never blocks today's IN -- that
-- dangling day just gets flagged "Punch In Only" by evaluate_day() instead.
-- Cooldown (2 min) is checked against the single most-recent punch overall,
-- not scoped to today, matching the original.

create or replace function validate_punch_anti_fraud(
  p_emp_id text,
  p_action punch_action
) returns table (
  valid boolean,
  message text
)
language plpgsql
stable
as $$
declare
  cooldown_minutes constant int := 2; -- CONFIG.PUNCH_COOLDOWN_MINUTES
  tz constant text := 'Asia/Kolkata'; -- old system ran on Session.getScriptTimeZone() (IST)
  v_last_ever punch_logs%rowtype;
  v_last_today punch_logs%rowtype;
  v_seconds_left int;
  v_day_start timestamptz := date_trunc('day', now() at time zone tz) at time zone tz;
begin
  -- Cooldown: based on the single most recent punch overall (any day).
  select * into v_last_ever
    from punch_logs
    where emp_id = p_emp_id
    order by punched_at desc
    limit 1;

  if found then
    if now() - v_last_ever.punched_at < make_interval(mins => cooldown_minutes) then
      v_seconds_left := ceil(extract(epoch from (make_interval(mins => cooldown_minutes) - (now() - v_last_ever.punched_at))));
      return query select false, format('Please wait %s more second(s) before punching again.', v_seconds_left);
      return;
    end if;
  end if;

  -- Day-scoped sequence check: only today's (IST calendar day) punches matter.
  select * into v_last_today
    from punch_logs
    where emp_id = p_emp_id
      and punched_at >= v_day_start
      and punched_at < v_day_start + interval '1 day'
    order by punched_at desc
    limit 1;

  if p_action = 'IN' then
    if found and v_last_today.action = 'IN' then
      return query select false, format('You already punched IN today at %s. Please punch OUT first.', to_char(v_last_today.punched_at at time zone tz, 'HH24:MI:SS'));
      return;
    end if;
    return query select true, 'OK';
    return;
  end if;

  -- p_action = 'OUT'
  if not found then
    return query select false, 'Cannot Punch OUT — no Punch IN found for today.';
    return;
  end if;
  if v_last_today.action = 'OUT' then
    return query select false, format('You already punched OUT today at %s. Please punch IN first.', to_char(v_last_today.punched_at at time zone tz, 'HH24:MI:SS'));
    return;
  end if;

  return query select true, 'OK';
end;
$$;

grant execute on function validate_punch_anti_fraud(text, punch_action) to authenticated;
