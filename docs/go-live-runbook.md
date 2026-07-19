# Go-Live Runbook — BCI GPS Attendance System

Launch date: **2026-08-01**. Clean cutover, no parallel run, no historical
data migrated (see `.claude/plan.md` Section 16, Phase 6 entry for the
full decision history — this file is the actionable checklist version).

## Pre-launch checklist (complete before 2026-08-01)

- [ ] **Holidays entered** — real BCI holiday list added via
      `/admin/holidays`. Without this, any holiday that occurs is scored
      as an Absent day by `evaluate_day()`.
- [ ] **Staff accounts created** — all ~56 active employees have signed
      up at `/signup` (pick name → enter the email already on file →
      set password). Re-check coverage with the employees-vs-auth-users
      comparison before launch; anyone missing can't punch in on day one.
- [ ] **Index migration applied** — run
      `supabase/migrations/20260715010000_indexes.sql` in the Supabase
      SQL Editor (no `DATABASE_URL` in this repo, so every migration goes
      in by hand — same as all prior ones).
- [ ] **v2 migrations applied (device binding + mark-late)** — run, in
      order, `supabase/migrations/20260719000000_device_binding.sql` then
      `20260719010000_manual_late.sql` in the SQL Editor, BEFORE deploying
      the matching frontend. Both are deploy-safe with the old frontend
      (`device_enforcement` starts `'off'`; new params all default).
      Afterwards run `npm run test:parity` — all sections including the
      new `D:` and `ML:` ones must pass.
- [ ] **Device enforcement flipped ON** — after every active employee has
      punched at least once with the new frontend (each first punch
      auto-binds their phone), check for unbound staff:
      `select e.emp_id, e.name from employees e left join employee_devices d using (emp_id) where e.status = 'Active' and d.emp_id is null;`
      When that returns zero rows (recommended: evening of go-live day),
      flip the gate:
      `update app_config set value = 'on' where key = 'device_enforcement';`
      Until this is on, punches sent without a device id (old clients,
      hand-crafted calls) are still accepted.
- [ ] **Supabase project not paused** — Free tier auto-pauses a project
      after 7 days with zero activity. Log in / hit the app once in the
      days right before 2026-08-01 to be sure it's warm, since a paused
      project would block every punch on launch morning.
- [ ] **Latest deploy confirmed live** — check Vercel shows the current
      `main` HEAD deployed (dashboard punch-vs-leave fix, index
      migration file, etc.), not a stale build.
- [ ] **Stray leftover auth account removed** — `teststaff@example.com`
      (found 2026-07-15) is an auth user with no matching employee row,
      left over from earlier testing. Harmless (RLS gives it no data
      access) but worth deleting via Supabase Auth → Users for a clean
      user list.
- [ ] **Old Apps Script system left untouched** — do NOT freeze, archive,
      or disable the old Google Sheet or Apps Script deployment yet.
      It stays live and usable as the rollback path through the first
      month. Freezing it is a **Phase 7** action, only after a clean
      August on the new system.
- [ ] **One final live click-through** on the production Vercel URL
      (not `localhost`) covering: staff signup → punch IN (real GPS,
      real device) → staff dashboard → leave submission with a proof
      upload → admin Today dashboard → admin approves the leave →
      admin Reports/Punch Logs spot-check. Confirms the deployed build
      behaves like the last verified local one.

## Rollback plan (if a blocking issue appears after launch)

**Trigger:** any issue that stops staff from punching in or blocks
payroll-relevant data (not a cosmetic bug).

**Window:** 48 hours from when the issue is confirmed.

**Action:**
1. Tell staff to go back to using the old Apps Script URL for punching
   in (it was never touched, per the pre-launch checklist above).
2. Fix the issue in the new system without time pressure, on its own
   deploy.
3. Re-verify (same click-through as pre-launch) before switching staff
   back to the new URL.

Because the old sheet/deployment is deliberately kept alive and unfrozen
through this whole first month, rollback is **only a URL switch** — no
data restore, no redeploy of the old system needed.

## What "clean" looks like at the end of the first month

- No unresolved blocking issues raised during August.
- `run_monthly_finalize()`'s September-1 rollup for August produces
  sane, spot-checked `monthly_summary` rows (this is the first real
  month-end run on live production data — worth a manual spot-check
  against a couple of employees' actual attendance that month).
- Once confirmed clean → **Phase 7**: freeze the old sheet to read-only,
  remove Apps Script triggers, archive the old deployment.
