-- current_employee_id()/is_admin() are called via supabase.rpc() from the
-- app (login routing, admin/staff shell pages) using the logged-in user's
-- own session, which runs as Postgres role `authenticated` over PostgREST.
grant execute on function public.current_employee_id() to authenticated;
grant execute on function public.is_admin() to authenticated;
