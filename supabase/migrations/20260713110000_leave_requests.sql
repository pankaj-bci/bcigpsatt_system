-- Phase 3, Task 9: leave request submit + admin approve/reject RPCs.
-- Ported from legacy-apps-script/attendanceengine.gs (Leave_submitRequest,
-- Leave_adminAction) and database.gs (DB_saveLeaveRequest,
-- DB_updateLeaveStatus).
--
-- Scope note: this is the RPC half of the "server action + RPC" split
-- (plan.md Section 5.1 / 6.2). The actual file upload to Supabase Storage
-- (replacing the old Drive-share-link hack, O10) is Next.js server-action
-- work for Phase 4 — these RPCs just record whatever `proof_path` the
-- caller already uploaded, same as the legacy code treated `proofLink` as
-- an opaque string handed to it after the Drive upload already happened.
--
-- Deliberately NOT validating leave_from <= leave_to, checking for
-- overlapping requests, or restricting by employee_type: the legacy
-- Leave_submitRequest has none of these checks -- "informational only,
-- does NOT affect salary" per its own docstring -- so adding validation
-- here would be new behaviour, not a port. Faithful-port decision, not an
-- oversight.
--
-- Neither function needs security definer: leave_requests' own RLS already
-- grants exactly the access each one needs (staff insert own row; admins
-- full access) — see 20260713010000_rls_policies.sql. Invoker rights only.

create or replace function submit_leave_request(
  p_leave_from   date,
  p_leave_to     date,
  p_request_type text,
  p_reason       text,
  p_approved_by  text,
  p_proof_path   text default null
) returns leave_requests
language plpgsql
as $$
declare
  v_emp_id text := current_employee_id();
  v_name text;
  v_row leave_requests%rowtype;
begin
  if v_emp_id is null then
    raise exception 'You are not registered as an employee.' using errcode = '42501';
  end if;

  select name into v_name from employees where emp_id = v_emp_id;

  insert into leave_requests (
    request_id, emp_id, name, leave_from, leave_to, request_type, reason,
    approved_by, proof_path, status
  ) values (
    'LR' || (extract(epoch from clock_timestamp()) * 1000)::bigint::text,
    v_emp_id, v_name, p_leave_from, p_leave_to, p_request_type, p_reason,
    p_approved_by, p_proof_path, 'Pending'
  )
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function submit_leave_request(date, date, text, text, text, text) to authenticated;

create or replace function admin_leave_action(
  p_request_id text,
  p_status     leave_status, -- 'Approved' | 'Rejected'
  p_admin_note text default null
) returns leave_requests
language plpgsql
as $$
declare
  v_row leave_requests%rowtype;
begin
  if not is_admin() then
    raise exception 'Admin access only.' using errcode = '42501';
  end if;

  update leave_requests
  set status = p_status,
      admin_note = coalesce(p_admin_note, '')
  where request_id = p_request_id
  returning * into v_row;

  if not found then
    raise exception 'Request ID "%" not found.', p_request_id;
  end if;

  return v_row;
end;
$$;

grant execute on function admin_leave_action(text, leave_status, text) to authenticated;
