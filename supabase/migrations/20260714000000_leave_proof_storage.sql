-- Phase 4: Supabase Storage bucket + policies for leave-request proof
-- uploads (O10 -- replaces the old Google Drive + public-sharing hack).
-- Private bucket, signed URLs only -- no public exposure.
--
-- Objects are stored as "{emp_id}/{filename}" so storage.foldername(name)[1]
-- doubles as an ownership check, mirroring the emp_id-prefix pattern already
-- used by every other RLS policy in this project (current_employee_id()).

insert into storage.buckets (id, name, public)
values ('leave-proofs', 'leave-proofs', false)
on conflict (id) do nothing;

create policy "staff upload own leave proof" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'leave-proofs' and (storage.foldername(name))[1] = current_employee_id());

create policy "staff read own leave proof" on storage.objects
  for select to authenticated
  using (bucket_id = 'leave-proofs' and (storage.foldername(name))[1] = current_employee_id());

create policy "admins read all leave proofs" on storage.objects
  for select to authenticated
  using (bucket_id = 'leave-proofs' and is_admin());
