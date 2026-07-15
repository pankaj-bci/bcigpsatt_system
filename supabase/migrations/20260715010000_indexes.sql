-- Missing indexes found in a pre-go-live review (2026-07-15).
-- Postgres does not auto-index foreign key columns, and RLS policies add
-- an invisible emp_id filter to every staff query -- leave_requests had
-- no index at all beyond its request_id primary key. punch_logs is the
-- one table with unbounded growth (every punch, forever); its existing
-- (emp_id, punched_at) index doesn't serve the admin/today-dashboard
-- queries that filter by date range across all employees instead.

create index on leave_requests (emp_id);
create index on leave_requests (status, leave_from, leave_to);
create index on punch_logs (punched_at, action);
