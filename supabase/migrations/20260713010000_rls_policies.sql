-- Row Level Security: the database enforces "staff see only their own rows,
-- admins see everything" even if a bug elsewhere asks for too much.
-- See .claude/plan.md Section 8 (RLS principles).

-- Helper: map the logged-in user's email (from their JWT) to their emp_id.
-- SECURITY DEFINER + owned by the migration role means this function bypasses
-- RLS on `employees` while it runs, so it can look itself up even though
-- `employees` also has RLS enabled below.
create or replace function public.current_employee_id()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select emp_id from employees
  where email = (auth.jwt() ->> 'email')::citext
  limit 1;
$$;

-- Helper: is the logged-in user's email in the admins table?
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from admins
    where email = (auth.jwt() ->> 'email')::citext
  );
$$;

-- ADMINS: locked down entirely. No policy for authenticated/anon means no
-- direct client access at all; only the SECURITY DEFINER functions above
-- (and the service role) can read it.
alter table admins enable row level security;

-- EMPLOYEES
alter table employees enable row level security;
create policy "staff read own employee row" on employees
  for select using (emp_id = current_employee_id());
create policy "admins full access to employees" on employees
  for all using (is_admin()) with check (is_admin());

-- LOCATIONS: every signed-in user needs these for the punch-location tiles.
alter table locations enable row level security;
create policy "authenticated read locations" on locations
  for select using (auth.role() = 'authenticated');
create policy "admins manage locations" on locations
  for all using (is_admin()) with check (is_admin());

-- PUNCH_LOGS
alter table punch_logs enable row level security;
create policy "staff read own punches" on punch_logs
  for select using (emp_id = current_employee_id());
create policy "staff insert own punches" on punch_logs
  for insert with check (emp_id = current_employee_id());
create policy "admins full access to punch_logs" on punch_logs
  for all using (is_admin()) with check (is_admin());

-- ATTENDANCE_SUMMARY (staff never write directly; computed server-side)
alter table attendance_summary enable row level security;
create policy "staff read own attendance summary" on attendance_summary
  for select using (emp_id = current_employee_id());
create policy "admins full access to attendance_summary" on attendance_summary
  for all using (is_admin()) with check (is_admin());

-- MONTHLY_SUMMARY (staff never write directly; computed server-side)
alter table monthly_summary enable row level security;
create policy "staff read own monthly summary" on monthly_summary
  for select using (emp_id = current_employee_id());
create policy "admins full access to monthly_summary" on monthly_summary
  for all using (is_admin()) with check (is_admin());

-- LEAVE_REQUESTS
alter table leave_requests enable row level security;
create policy "staff read own leave requests" on leave_requests
  for select using (emp_id = current_employee_id());
create policy "staff insert own leave requests" on leave_requests
  for insert with check (emp_id = current_employee_id());
create policy "admins full access to leave_requests" on leave_requests
  for all using (is_admin()) with check (is_admin());

-- HOLIDAYS: every signed-in user can read; only admins add/remove.
alter table holidays enable row level security;
create policy "authenticated read holidays" on holidays
  for select using (auth.role() = 'authenticated');
create policy "admins manage holidays" on holidays
  for all using (is_admin()) with check (is_admin());
