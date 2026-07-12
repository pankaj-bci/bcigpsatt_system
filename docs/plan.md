# BCI GPS Attendance System — Migration Plan
### From Google Sheets + Apps Script → Supabase + Vercel (Next.js, GitHub-deployed)

**Document status:** Draft v1 — ready for review
**Author:** Prepared from a full read of the current codebase (9 source files)
**Owner:** _(you)_
**Last updated:** _(fill in)_

---

## 0. How to use this document

This is the single source of truth for the migration. Read sections 1–4 first (why + what "done" means), then 5–7 (target design), then 8 onward (execution). Section 4 (the **Output Matrix**) is the acceptance contract: the migration is "done" only when every row's success metric is met.

Two things are needed from you before Phase 3 can start — both are listed in **Section 6 (Blockers & Decisions Needed)**. Nothing before Phase 3 is blocked, so work can begin immediately.

---

## 1. Problem Statement

The current system is a production GPS attendance app for BCI, built entirely on **Google Apps Script (backend)** + **Google Sheets (database)** + **HtmlService (two HTML frontends)**. It works and is feature-complete, but staff report three recurring problems:

| # | Symptom (as reported) | What's actually happening (from the code) |
|---|---|---|
| P1 | "The system is slow." | Google Sheets is used as an OLTP database. Every data read is a full-range `getDataRange().getValues()` costing ~800–2000 ms, partially masked by three caching layers (`CacheService`, a per-execution `_execCache`, and a 5-minute "warmup" trigger to fight cold starts). Dashboard loads even *write* on read (`Attendance_backfillMissingDays` + `Report_generateMonthlySummary` run during `Server_getMyDashboard`). |
| P2 | "Sometimes it randomly says to wait, the system is busy." | This is the literal message from `Attendance_processPunch`. Every punch in the entire organisation is serialized through **one global** `LockService.getScriptLock().waitLock(20000)`. Each punch also performs slow sheet writes *and* a full same-day re-evaluation. During the morning punch-in rush, punches queue behind the single lock; when the 20 s wait is exceeded, the user sees `"System busy, please try again in a moment."` |
| P3 | "It looks ordinary — everything is managed through a Google Sheet." | The data lives in 8 raw spreadsheet tabs with no types, no constraints, no indexes, no real admin surface beyond the sheet itself. This is both a perception problem (unprofessional) and an operational risk (a mis-click in the sheet corrupts production data). |

**Root cause, in one line:** a spreadsheet is being used as a concurrent transactional database, and a single-threaded script lock is being used as a concurrency control. Both are the wrong tool for a multi-user, time-of-day-bursty workload.

**Migration thesis:** moving storage to **Postgres (Supabase)** and hosting to **Vercel/Next.js** removes P1 and P2 *by construction* (Postgres does millisecond indexed reads and native row-level concurrency — no global lock), and gives a real, modern UI surface that removes P3.

---

## 2. Goals & Non-Goals

### Goals
1. **Speed:** punch and dashboard operations feel instant (see Output Matrix for hard numbers).
2. **Concurrency:** dozens of simultaneous morning punches succeed with zero "system busy" errors.
3. **Professional UX:** a clean staff PWA and a real admin dashboard; no one ever touches a raw spreadsheet.
4. **Behavioural parity:** every attendance rule (Fixed vs Probation buckets, allowances, credits, working-Sunday, backfill, extra-days) produces *identical* results to today. This is non-negotiable — payroll depends on it.
5. **Same login experience:** staff continue to sign in with their own Google account (personal Gmail included).
6. **Maintainability:** business logic in version-controlled code (GitHub), not scattered in a bound script.

### Non-Goals (explicitly out of scope for this migration)
- Changing any attendance *policy* or thresholds (this is a like-for-like port, not a redesign).
- Adding new features (payroll export, biometric, face-match, etc.) — can come after cutover.
- Migrating historical Apps Script *logs*.
- Multi-org / multi-tenant support.

---

## 3. Success Definition (plain language)

The migration is complete when, for one full calendar month, the new system runs in parallel with the old one and produces the **same monthly summary numbers for every employee**, while measurably beating the old system on speed and never showing a "system busy" error. Detailed, measurable criteria are in the Output Matrix below.

---

## 4. Output Matrix (Acceptance Contract)

Each row maps a problem → its root cause → the target solution → a **measurable** success metric and how to verify it. This table is the definition of "done."

| ID | Problem | Root Cause | Target Solution | Success Metric (measurable) | Verification Method |
|----|---------|-----------|-----------------|-----------------------------|---------------------|
| **O1** | Slow reads | Sheets full-range reads (800–2000 ms) | Postgres with indexes on `(emp_id, date)`, `(emp_id, datetime)` | Dashboard API p95 **< 400 ms**; punch API p95 **< 800 ms** | Load test + Vercel/Supabase logs |
| **O2** | "System busy" under load | Single global `ScriptLock` serializes all punches | Transactional Postgres RPC; per-employee concurrency only (no global lock) | **0** "busy"/timeout errors at **≥56 concurrent punches** (full active staff); 100% success | k6/Artillery load test simulating 9:30 AM rush |
| **O3** | Cold starts / warmup hack | Apps Script container spin-down | Serverless + always-on Postgres; drop warmup trigger | First request after idle **< 1.5 s**; warmup trigger removed | Cold-start timing test |
| **O4** | Unprofessional UI | Raw Google Sheets management | Next.js admin dashboard + staff PWA on Vercel | Admin performs **all** ops (add employee/location/holiday, approve leave, view reports) without opening a spreadsheet | Admin UAT checklist |
| **O5** | Data-integrity risk | No types/constraints in sheets | Typed columns, FKs, `CHECK` constraints, unique indexes, RLS | Invalid writes (dup emp_id, bad status, punch spoof) rejected at DB layer | Negative test suite |
| **O6** | Payroll correctness | Logic scattered; must not regress | Ported policy engine + **parity test suite** | New vs old monthly summary **identical for 100% of employees** over 1 parallel month | Automated diff of MONTHLY_SUMMARY old vs new |
| **O7** | Login for any Google account | Apps Script `Session.getActiveUser()` | Supabase Auth with Google OAuth | Any Google account (incl. personal Gmail) can sign in; admin/staff routing correct | Auth UAT with 3 account types |
| **O8** | GPS geofencing fidelity | Haversine + WFH/OTHER inverted checks in GAS | Port haversine + geofence rules to server (RPC/Edge) | Punch IN/OUT accept/reject decisions match old system on a fixed test set of coordinates | Geofence test vectors |
| **O9** | Scheduled jobs | GAS time-triggers (nightly/monthly) | Supabase `pg_cron` (or Vercel Cron) | Nightly recompute + monthly rollup run on schedule; verified output | Scheduled-run logs + spot check |
| **O10** | Leave proof uploads | Google Drive + public sharing hack | Supabase Storage with signed URLs | Upload works; admin views proof via signed URL; no public exposure | Leave-flow UAT |

---

## 5. Current System Inventory (what we're porting)

A precise catalogue so nothing is missed. Everything below was extracted from the uploaded files.

### 5.1 Data entities (8 Google Sheet tabs → 8 Postgres tables)

| Sheet | Columns (current) | Notes for migration |
|-------|-------------------|---------------------|
| `EMPLOYEES` | emp_id, name, email, employee_type, assigned_location_id, shift_start_time, status | `emp_id` is zero-padded to 4 chars in code (`_normalizeEmpId`). `employee_type` ∈ {Fixed, Probation}. `status` ∈ {Active, Inactive}. Note: `shift_start_time` exists per-employee but the policy currently uses the **global** `CONFIG.SHIFT` — confirm intended behaviour. |
| `LOCATIONS` | location_id, location_name, latitude, longitude, radius | `radius` in metres. `L1` = Head Office (seeded from CONFIG). |
| `PUNCH_LOGS` | log_id, emp_id, action, datetime, latitude, longitude, locationType, locationName | `action` ∈ {IN, OUT}. `locationType` ∈ {HEAD_OFFICE, WORKSHOP, WFH, OTHER}. `datetime` stored as `yyyy-MM-dd HH:mm:ss` string (lots of Date-vs-string normalization code exists because Sheets is inconsistent — Postgres `timestamptz` eliminates this entire class of bug). |
| `ATTENDANCE_SUMMARY` | emp_id, date, in_time, out_time, status, late_flag, early_flag, half_day_flag, working_sunday, leave_credit_used, notes | One row per employee per day. Upserted on `(emp_id, date)`. |
| `MONTHLY_SUMMARY` | emp_id, month, working_days, total_present, total_late, total_early, total_half_days, total_absent, total_unpaid_absent, total_leaves_used, total_working_sundays, late_early_used, leave_credits_used | Rollup, upserted on `(emp_id, month)`. |
| `LEAVE_REQUESTS` | request_id, emp_id, name, leave_from, leave_to, request_type, reason, approved_by, proof_link, status, timestamp, admin_note | `status` ∈ {Pending, Approved, Rejected}. Info-only (no salary impact). |
| `HOLIDAYS` | date, holiday_name | `date` = `yyyy-MM-dd`. |
| `ADMIN` | email | Membership = admin rights. |

### 5.2 Server API surface (Apps Script `Server_*` → new endpoints)

These are every entry point the two frontends call. The new backend must expose an equivalent for each.

**Staff frontend (`frontend.html`) calls:**
`Server_getUserInfo`, `Server_getMyLastPunch`, `Server_recordPunch`, `Server_getMyDashboard`, `Server_getAllLocations`, `Server_getLeaveFormConfig`, `Server_submitLeave`, `Server_getMyLeaveRequests`.

**Admin frontend (`admin.html`) calls:**
`Server_getUserInfo`, `Server_getTodayDashboard`, `Server_getAdminReport`, `Server_getAllEmployees`, `Server_addEmployee`, `Server_updateEmployee`, `Server_getAllLocations`, `Server_addLocation`, `Server_getHolidayList`, `Server_addHoliday`, `Server_deleteHoliday`, `Server_getAllPunchLogs`, `Server_getTodayPunchLogs`, `Server_getAllLeaveRequests`, `Server_getTodayLeaveRequests`, `Server_adminLeaveAction`.

### 5.3 Business logic modules to port

1. **Geofencing** (`LocationUtils.gs`): haversine distance; `validatePunchIn` (assigned location only); `validatePunchOut` (assigned OR head office); WFH/OTHER **inverted** checks (must be > 5 km / > 2 km from head office); GPS accuracy gate (≤ 100 m).
2. **Anti-fraud** (`AttendanceEngine.gs → Attendance_validateAntiFraud`): day-scoped IN/OUT sequencing (yesterday's forgotten OUT never blocks today), 2-minute cooldown, duplicate-action prevention.
3. **Policy engine** (`Policy_evaluateDay` + `Policy_evaluateAbsent` / `Policy_evaluateProbation` / `Policy_evaluateFixed`): the per-day status decision + credit accounting. Verified spec in **Appendix A**; quirks in **Appendix C**.
4. **Counters** (`_computeCountersFromDailies`): running late/early + credit counters computed from daily records mid-month (deliberately *not* from MONTHLY_SUMMARY — that caused a known bug).
5. **Backfill** (`Attendance_backfillMissingDays`): fills untouched past working days when a dashboard first loads.
6. **Extra days** (`Attendance_getExtraDaysYearly`): Working-Sunday/Holiday → +0.5 (<4 h) or +1 (≥4 h or missing OUT), summed per calendar year.
7. **Monthly rollup** (`Report_generateMonthlySummary` + `Report_countWorkingDays`): aggregates dailies; working days = month days − weekly-offs − holidays.
8. **Leave** (`LeaveService`): submit (with optional proof upload), admin approve/reject.
9. **Triggers** (`Code.gs`): nightly (11 PM) recompute-yesterday-for-all + monthly rollup; monthly (1st, 1 AM) finalize prior month; warmup (every 5 min — becomes obsolete).

### 5.4 Frontend structure

- **Staff** (`frontend.html`, ~900 lines): **dark theme, mobile-first PWA**. 3 views — Punch (location tiles + IN/OUT, live GPS via `navigator.geolocation.watchPosition`, `enableHighAccuracy:true`), Dashboard (monthly stats), Leave (form + history). Bottom tab bar: PUNCH / DASHBOARD / LEAVE.
- **Admin** (`admin.html`, ~928 lines): **light theme, desktop dashboard**. 8 sections — Today (live tiles), Reports, Leaves, Logs, Employees, Add Employee, Add Location, Holidays.
- Exact visual reference (labels, tiles, colours, layout) captured from the live screenshots in **Appendix D**. The rebuild should preserve both themes and the tile/label wording.

---

## 6. Blockers & Decisions Needed (read before Phase 3)

### 6.1 ✅ RESOLVED — the real Policy Engine file
_(Originally a blocker: the file first uploaded under `policyengine.gs` was a duplicate of `locationutils.gs`.)_ The real `PolicyEngine.gs` has now been provided and reviewed line-by-line. **Appendix A** is now the **verified, exact** spec (not a reconstruction). The review surfaced several subtle behaviours that a naïve rewrite would get wrong — these are catalogued in **Appendix C (Policy quirks & port decisions)** and are the highest-value inputs to the parity harness (**O6**). One product decision is now needed: for each quirk in Appendix C, decide **"replicate exactly"** (safe, guarantees parity) or **"fix during port"** (changes numbers, needs sign-off). Default recommendation: replicate exactly for cutover, fix later as a separate change.

### 6.2 🟡 DECISION — Where does business logic run?
Two viable placements; recommendation given.

- **Option A (recommended): Postgres RPC functions (`plpgsql`) for the transactional core** (punch insert + anti-fraud + day evaluation in one atomic transaction) + **thin Next.js server actions/route handlers** for orchestration and admin CRUD. Rationale: the anti-fraud sequencing and punch insert *must* be atomic; doing it inside a single DB transaction with a per-employee advisory lock is far safer and faster than the old global ScriptLock, and removes all races by design.
- **Option B: Supabase Edge Functions (Deno/TypeScript)** for logic, Postgres for storage only. Rationale: keeps logic in TypeScript (easier to unit-test, closer to the old JS). Downside: punch flow needs a DB transaction anyway, so you end up round-tripping.

**Recommendation:** hybrid — atomic punch + evaluation as a **Postgres RPC**; everything else (dashboards, reports, admin CRUD, leave) as **Next.js server-side code** calling Supabase with the service role. This gives correctness where it matters and developer velocity everywhere else.

### 6.3 🟡 DECISION — Reverse geocoding
The old system uses Apps Script's built-in `Maps.newGeocoder()` (free, no key). That is **not available** off Apps Script. Options: (a) drop reverse-geocoding (it's only used for a human-readable address display — punch validation uses raw lat/lon, so nothing breaks); (b) Google Maps Geocoding API (needs a key + billing); (c) free OSM Nominatim (rate-limited, attribution required). **Recommendation:** (a) drop it for launch, store raw coordinates only; add (b) later if admins want addresses. _Confirm._

### 6.4 🟡 DECISION — `shift_start_time` per employee
The column exists per employee but the current policy uses the **global** `CONFIG.SHIFT`. Confirm whether per-employee shift start should finally be honoured, or kept global (simplest parity path = keep global, migrate the column as-is for future use).

### 6.5 ✅ RESOLVED — Screenshots received
Admin (light desktop dashboard) and staff (dark mobile PWA) screenshots received and captured as a UI reference in **Appendix D**. Phase 4 will match this look and wording.

---

## 7. Target Architecture

```
                          ┌─────────────────────────────────────────┐
   Staff phone            │              Vercel (GitHub CD)          │
   Admin browser  ─────►  │   Next.js App Router (React, PWA)        │
                          │   ├─ /(staff)  punch · dashboard · leave │
                          │   └─ /(admin)  today · reports · manage  │
                          │   Server Actions / Route Handlers        │
                          └───────────────┬─────────────────────────┘
                                          │  supabase-js (RLS-scoped)
                                          ▼
                          ┌─────────────────────────────────────────┐
                          │                Supabase                  │
                          │  ├─ Auth (Google OAuth)                  │
                          │  ├─ Postgres (8 tables, RLS, indexes)    │
                          │  │    └─ RPC: record_punch() [atomic]    │
                          │  │    └─ RPC: evaluate_day(), rollup()   │
                          │  ├─ Storage (leave proofs, signed URLs)  │
                          │  └─ pg_cron (nightly + monthly jobs)     │
                          └─────────────────────────────────────────┘
```

**Why this removes P1/P2/P3:**
- **P2 (busy):** no global lock. Concurrent punches are independent row inserts; the only serialization is a *per-employee* advisory lock inside `record_punch()`, held for microseconds. 50 employees punching at 9:30 = 50 independent fast transactions.
- **P1 (slow):** indexed Postgres reads are 1–20 ms vs 800–2000 ms. No more warmup hack, no write-on-read.
- **P3 (looks ordinary):** a real Next.js admin console; the spreadsheet disappears.

**Stack choices (recommended):**
- Framework: **Next.js (App Router) + TypeScript + Tailwind**, deployed on **Vercel** from **GitHub** (push-to-deploy).
- Auth: **Supabase Auth → Google provider**. Admin vs staff resolved by an `admins` table (or a `role` claim) mirroring the old ADMIN sheet.
- DB: **Supabase Postgres**. Storage: **Supabase Storage**. Cron: **`pg_cron`** (fallback: Vercel Cron hitting a protected route).

---

## 8. Data Model (Postgres) — first-cut DDL

This is the target schema. Types replace the string-normalization gymnastics the old code needed. (Final DDL to be committed in the repo; this is the design.)

```sql
-- ENUMS
create type employee_type as enum ('Fixed','Probation');
create type emp_status    as enum ('Active','Inactive');
create type punch_action  as enum ('IN','OUT');
create type location_type as enum ('HEAD_OFFICE','WORKSHOP','WFH','OTHER');
create type leave_status  as enum ('Pending','Approved','Rejected');

-- LOCATIONS
create table locations (
  location_id   text primary key,          -- 'L1', 'L2'...
  location_name text not null,
  latitude      double precision not null,
  longitude     double precision not null,
  radius        int not null default 100    -- metres
);

-- EMPLOYEES
create table employees (
  emp_id               text primary key,    -- 4-char zero-padded
  name                 text not null,
  email                citext unique not null,
  employee_type        employee_type not null default 'Fixed',
  assigned_location_id text references locations(location_id),
  shift_start_time     text default '09:30',
  status               emp_status not null default 'Active'
);

-- ADMINS (mirrors ADMIN sheet)
create table admins ( email citext primary key );

-- PUNCH_LOGS
create table punch_logs (
  log_id        bigint generated always as identity primary key,
  emp_id        text not null references employees(emp_id),
  action        punch_action not null,
  punched_at    timestamptz not null default now(),
  latitude      double precision,
  longitude     double precision,
  location_type location_type,
  location_name text
);
create index on punch_logs (emp_id, punched_at);

-- ATTENDANCE_SUMMARY (one row per emp per day)
create table attendance_summary (
  emp_id            text not null references employees(emp_id),
  date              date not null,
  in_time           time,
  out_time          time,
  status            text,
  late_flag         boolean default false,
  early_flag        boolean default false,
  half_day_flag     boolean default false,
  working_sunday    boolean default false,
  leave_credit_used numeric(3,1) default 0,
  notes             text,
  primary key (emp_id, date)
);

-- MONTHLY_SUMMARY (rollup)
create table monthly_summary (
  emp_id                text not null references employees(emp_id),
  month                 text not null,       -- 'yyyy-MM'
  working_days          int, total_present int, total_late int,
  total_early int, total_half_days int, total_absent int,
  total_unpaid_absent int, total_leaves_used numeric(4,1),
  total_working_sundays int, late_early_used int,
  leave_credits_used numeric(4,1),
  primary key (emp_id, month)
);

-- LEAVE_REQUESTS
create table leave_requests (
  request_id   text primary key,
  emp_id       text not null references employees(emp_id),
  name         text,
  leave_from   date, leave_to date,
  request_type text, reason text, approved_by text,
  proof_path   text,                         -- Supabase Storage path
  status       leave_status not null default 'Pending',
  created_at   timestamptz not null default now(),
  admin_note   text
);

-- HOLIDAYS
create table holidays ( date date primary key, holiday_name text not null );
```

**RLS (Row Level Security) principles:**
- Staff can `select`/`insert` only their **own** punch logs and leave requests, and read only their own summaries.
- Admins (email in `admins`) can read/write everything.
- All policy enforcement also duplicated server-side; RLS is defence-in-depth, not the only gate.

---

## 9. Business-Logic Port Plan (with parity requirement)

Each module ported and covered by a test that proves it matches the old output. **No module is "done" without a passing parity test.**

| Module | Old location | New home | Parity test |
|--------|--------------|----------|-------------|
| Haversine + geofence | `LocationUtils.gs` | SQL helper / TS util | Fixed set of (lat,lon,location) → expected accept/reject |
| Accuracy gate (≤100 m) | `Loc_validateAccuracy` | `record_punch()` RPC | Boundary values 99/100/101 m |
| Anti-fraud (day-scoped, cooldown, sequence) | `Attendance_validateAntiFraud` | inside `record_punch()` txn | Scenario matrix: dup IN, OUT-without-IN, <2 min cooldown, yesterday's open IN |
| Policy day evaluation | `Policy_evaluateDay` (+3 sub-fns) | `evaluate_day()` RPC | **Appendix A** vectors + **Appendix C** quirk cases (must-pass) |
| Running counters | `_computeCountersFromDailies` | SQL aggregate | Mid-month deduction sequence (3 free → 0.5 each) |
| Backfill | `Attendance_backfillMissingDays` | batch RPC / job | New employee mid-month → correct catch-up rows |
| Extra days (yearly) | `Attendance_getExtraDaysYearly` | SQL view/function | <4 h vs ≥4 h vs missing-OUT cases |
| Monthly rollup | `Report_generateMonthlySummary` | `generate_monthly()` RPC + cron | Full-month diff old vs new = 0 |
| Working-days count | `Report_countWorkingDays` | SQL function | Any month w/ holidays + Sundays |
| Leave submit/approve | `LeaveService` | server action + RPC | Submit w/ proof; approve; reject |

**Parity harness:** export the current MONTHLY_SUMMARY and ATTENDANCE_SUMMARY for the last 1–2 months, feed the same PUNCH_LOGS through the new engine, and assert byte-equal results. This is the single most important test gate before cutover (**O6**).

---

## 10. Auth & Roles

- **Provider:** Supabase Auth with Google OAuth (matches "any Google account, including personal Gmail").
- **Routing:** after login, look up the signed-in email. If in `admins` → admin app; else if in `employees` (Active) → staff app; else → "Access Denied / contact admin" page (mirrors old `_pageAccessDenied`).
- **Sessions:** Supabase JWT; server actions verify the JWT and derive `emp_id`/role server-side (never trust the client).
- **Migration of ADMIN list:** import the `ADMIN` sheet rows into the `admins` table verbatim.

---

## 11. Scheduled Jobs

| Job | Old | New | Schedule |
|-----|-----|-----|----------|
| Nightly recompute (yesterday, all employees) + monthly refresh | `Attendance_runDailyTrigger` | `pg_cron` → `run_daily_recompute()` | 23:00 Asia/Kolkata |
| Monthly finalize (prior month) | `Report_runMonthlyTrigger` | `pg_cron` → `generate_monthly(prev_month)` | 1st @ 01:00 |
| Warmup (keep container hot) | `Attendance_warmupTrigger` | **DELETED** — not needed | — |

If `pg_cron` isn't preferred, use **Vercel Cron** hitting a secret-protected route that calls the same RPCs. Timezone must be pinned to **Asia/Kolkata** in both the DB functions and cron config.

---

## 12. Migration & Cutover Plan (phased)

Each phase has an entry gate, tasks, and an exit/acceptance gate. Do not start a phase until the previous phase's exit gate is green.

### Phase 0 — Prep & decisions _(no code)_
- Collect the real `Policy_evaluateDay` (6.1), confirm decisions 6.2–6.4, receive screenshots (6.5).
- Create Supabase project + GitHub repo + Vercel project (empty, wired for push-to-deploy).
- **Exit:** blockers resolved or explicitly deferred with agreed defaults.

### Phase 1 — Schema & Auth
- Commit DDL (Section 8), enums, indexes, RLS policies.
- Wire Supabase Google OAuth; build the login → role-routing shell (empty pages).
- **Exit:** a Google account can sign in and land on the correct (empty) app; RLS blocks cross-employee reads (negative test passes) → contributes to **O5, O7**.

### Phase 2 — Data migration
- Export all 8 sheets to CSV. Transform: zero-pad `emp_id`; parse dates/times to `timestamptz`/`date`/`time`; dedup; validate FKs (every punch's `emp_id` exists, every `assigned_location_id` exists).
- Load into Postgres. Reconcile row counts old vs new.
- **Exit:** counts match; no orphan FKs; spot-check 10 employees' data identical.

### Phase 3 — Logic port + parity
- Implement `record_punch()` (atomic: accuracy → geofence → anti-fraud → insert → `evaluate_day`), `evaluate_day()`, counters, backfill, extra-days, `generate_monthly()`.
- Build the **parity harness** (Section 9) against last 1–2 months.
- **Exit:** parity diff = 0 for all employees over the test window → **O6, O8**. _(Requires 6.1.)_

### Phase 4 — Frontends
- Staff PWA: punch (GPS tiles, IN/OUT, live accuracy), dashboard, leave. Admin: 8 sections. Match screenshots.
- Wire every endpoint from Section 5.2 to its new equivalent.
- **Exit:** full staff + admin UAT checklist passes → **O4, O10**.

### Phase 5 — Scheduled jobs + load test
- Enable `pg_cron` jobs; verify nightly + monthly outputs.
- Run load test: 50 concurrent punches, measure p95, assert 0 busy errors and 0 duplicate/inconsistent rows.
- **Exit:** **O1, O2, O3, O9** metrics met.

### Phase 6 — Parallel run & cutover
- Run new system **alongside** old for a defined window (recommend to a month boundary). Compare daily.
- Cutover: point staff to the new URL; freeze writes to the sheet.
- **Rollback plan:** if a blocking issue appears within 48 h, revert the staff URL to the Apps Script deployment (kept live, read-only sheet re-enabled). Because the sheet isn't deleted, rollback is a URL switch.

### Phase 7 — Decommission
- After a clean parallel month, archive the Google Sheet (read-only), remove GAS triggers, retire the Apps Script deployment.
- **Exit:** old system archived; runbook + env docs committed.

---

## 13. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Missing policy engine file → subtle payroll drift | High | Parity harness gate (O6); do not cut over until diff = 0. Get the real file (6.1). |
| Timezone bugs (Asia/Kolkata vs UTC) | High | Store `timestamptz`; pin session/cron TZ; test around midnight and month boundaries. |
| GPS accuracy differences across devices | Medium | Keep the exact ≤100 m gate + WFH/OTHER distance thresholds from CONFIG; test vectors (O8). |
| Google OAuth misconfig blocks staff login | High | Test with 3 real account types in Phase 1; keep old system live during parallel run. |
| Concurrency edge cases (double-punch) | Medium | Atomic RPC + per-employee advisory lock + cooldown; concurrency test in Phase 5. |
| Data-migration mismatch (Date-as-string rows) | Medium | Explicit transform + reconciliation in Phase 2; the old code's normalization comments document every quirk. |
| Reverse-geocode removal surprises admins | Low | Decision 6.3; store raw coords; add addresses later if wanted. |

---

## 14. Repo & Environment (proposed)

```
/attendance-app
  /app
    /(staff)/punch  /(staff)/dashboard  /(staff)/leave
    /(admin)/today  /(admin)/reports  /(admin)/manage ...
    /api/cron/*                      # if using Vercel Cron
  /lib/supabase  /lib/geo  /lib/policy
  /supabase
    /migrations/*.sql                # DDL, RLS, RPCs, cron
    /tests/parity/*                  # parity harness + vectors
  /docs/plan.md                      # this file
```

**Env vars:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (server-only), `CRON_SECRET` (if Vercel Cron), Google OAuth client id/secret (in Supabase Auth config). Secrets live in Vercel/Supabase env settings, never in the repo.

---

## 15. Open Questions (please answer inline)

1. ~~Real `Policy_evaluateDay()` source?~~ ✅ **Received & verified.** Instead: for each Appendix C quirk (C-1…C-7), confirm **Replicate** vs **Fix**. Default = Replicate all.
2. Logic placement: confirm hybrid RPC + Next.js? (6.2)
3. Reverse-geocode: drop for launch? (6.3)
4. Per-employee `shift_start_time`: honour it now, or keep global? (6.4)
5. Parallel-run length: one full calendar month, or shorter? (Phase 6)
6. Expected peak concurrency — with **56 active staff**, worst case is ~56 punches in the 9:30 window. Confirm if that's the right upper bound for the O2 load test, or if morning punch-in clusters tighter.
7. ~~How many employees?~~ ✅ **~56 active** (from the admin screenshot). Still needed: rough count of **historical punch rows** (sizes the Phase 2 export/import).
8. ~~Send admin + staff screenshots?~~ ✅ **Received** — captured in Appendix D.

---

## Appendix A — Verified Policy Spec (from the real `PolicyEngine.gs`)

> ✅ Verified against the actual source. This is the authoritative behaviour the ported `evaluate_day()` must reproduce exactly. Read together with **Appendix C** (quirks).

**Shift:** start 09:30, end 18:30. **Weekly off:** Sunday (`WEEKLY_OFF_DAYS=[0]`). **Holidays:** from `HOLIDAYS`.

### Day evaluation order (short-circuits at first match)
1. **Public holiday?** → with any punch = **Working Holiday** (capture first IN / last OUT); no punch = **Holiday**. _(Note: Working Holiday does **not** set `working_sunday` and is **not** counted as present in the monthly rollup — but it **does** earn yearly extra-days.)_
2. **Sunday (weekly off)?** → with any punch = **Working Sunday** (`working_sunday=true`); no punch = **Weekly Off**.
3. **Working day, no punch at all** → `Policy_evaluateAbsent`.
4. **Punch IN but no Punch OUT** → **Punch In Only** — times preserved, `leave_credit_used=0`, **not counted as a working day** (neither present nor absent in the rollup).
5. **Probation** → `Policy_evaluateProbation`.
6. **Fixed** → `Policy_evaluateFixed`.

### Absent evaluation (working day, no valid pair)
- **Probation** → always **Unpaid Absent** (no credits, ever).
- **Fixed** → if `leave_credits_used < 1` → **Absent** + deduct **1 full** credit; else → **Unpaid Absent**.

### Fixed employees — PUNCH IN classification (`minsLate = inTime − 570`)
- ≤ 6 min (≤ 09:36) → **On Time**
- 7–90 min (09:37–11:00) → **Late**
- IN before 14:00 (but > 90 min late) → **Half Day**
- IN ≥ 14:00 → **Absent** (redirects to Absent logic; IN/OUT times still preserved on the row)

### Fixed — PUNCH OUT classification
- ≥ 18:30 → **On Time**
- 17:00–18:29 → **Early Going**
- 14:00–16:59 → **Half Day**
- before 14:00 → **Absent** — **unless** IN was already Half Day, in which case OUT stays **Half Day** (see Appendix C-1)

### Fixed — flags & monthly allowance logic (exact)
- `late_flag = (IN classified 'late')`; `early_flag = (OUT classified 'early')`; `half_day_flag = (IN half-day OR OUT half-day)`.
- **Half Day** (Case 1): status Half Day; deduct **0.5** credit **only if** `credits_used < 1`, else penalty half-day with no credit.
- **Late-only** or **Early-only** (Cases 2/3): `late_early_delta = 1`. If this pushes the running monthly count **> 3** free → converts to **Half Day** and deducts **0.5** credit (**no remaining-credit guard** — see Appendix C-2).
- **Both late IN and early OUT, same day** (Case 4): `late_early_delta = 2` (see Appendix C-3 for the counter/penalty inconsistency).
- **1** leave credit per month = 1 full day **or** 2 half-days. Per-day `leave_credit_used` ∈ {0, 0.5, 1}; per-day `late_early_delta` ∈ {0, 1, 2}.
- **Absent** on a working day → status `Absent`, deduct 1 credit; if none remain → `Unpaid Absent`.

### Probation employees — zero tolerance
- Violation if IN > 09:36 **or** IN missing; violation if OUT < 18:30 **or** OUT missing.
- Either violation alone → **Half Day** (`half_day_flag=true`, sets `late_flag`/`early_flag` to whichever fired). **No credit deducted, no late/early counter incremented** — probation half-days are pure penalty, they don't consume the Fixed-style allowance pool.
- Both correct → **Present**. Leave form = information only, no salary impact.

### GPS / location rules
- Reject if accuracy > **100 m**.
- **Punch IN:** only within assigned location's radius.
- **Punch OUT:** within assigned location **or** Head Office radius.
- **WFH:** valid only if **> 5 km** from Head Office. **OTHER:** valid only if **> 2 km**.
- Cooldown **2 min** between punches.

### Working Sunday / Holiday → extra days (yearly)
- Duration ≥ 4 h → **+1**; < 4 h → **+0.5**; missing OUT (has IN) → **+1**.

### Status vocabulary
`Present, Absent, Unpaid Absent, Half Day, Punch In Only, Weekly Off, Holiday, Working Sunday, Working Holiday, On Time, Late, Early Going`.

---

## Appendix C — Policy quirks & port decisions (READ BEFORE PORTING)

These are non-obvious behaviours in the real `PolicyEngine.gs`. A clean-room rewrite will "fix" them by accident and silently change payroll. For each, decide **Replicate** (default, guarantees O6 parity) or **Fix** (needs written sign-off + updated expected values). Every item below must have an explicit parity test case.

| # | Quirk (actual current behaviour) | Why it matters | Recommended |
|---|----------------------------------|----------------|-------------|
| **C-1** | If IN is Half-Day and OUT is any time before 14:00, the day stays **Half Day** (not Absent). The OUT-absent bucket is suppressed whenever IN is already half-day. | An on-time person leaving before 2 PM = Absent, but a late-half-day person leaving before 2 PM = Half Day. Asymmetric. | Replicate |
| **C-2** | The 4th+ late/early penalty deducts **0.5 credit with no check** on remaining credits, while the bucket-driven Half-Day path **does** guard (`credits_used < 1`). | Late-penalty can push a month's credits **above** the 1.0 limit; bucket half-days cannot. Two paths, two behaviours. | Replicate for cutover; flag for review |
| **C-3** | For **both late IN + early OUT** on the same day: `late_early_delta` is set to **2**, but the penalty/conversion logic (Case 2, `else if`) only ran once (+1) and only incremented the running counter by 1 before evaluating the >3 threshold. So the reported monthly delta (2) and the penalty decision (based on +1) disagree. | The running monthly `late_early_used` can drift vs the sum of daily deltas, affecting when the 4th-incident penalty triggers later in the month. | Replicate exactly; test a full month that crosses the 3→4 boundary via a both-violation day |
| **C-4** | **Punch In Only** (IN, no OUT) is neither present nor absent — it vanishes from monthly totals (no credit, no present, no absent). | A day worked-but-not-closed silently disappears from `total_present` and `total_absent`. Admin must catch it in the report. | Replicate; surface prominently in admin UI |
| **C-5** | **Working Holiday** is **not** counted in `total_present` in the monthly rollup (the rollup switch handles Present / Working Sunday / Half Day / Absent / Unpaid — not Working Holiday), yet it **does** count toward yearly extra-days. | Holiday work shows in extra-days but not in monthly present count. Intentional? Confirm. | Confirm with org; likely Replicate |
| **C-6** | Counters are computed mid-month from **daily records**, not `MONTHLY_SUMMARY` (`_computeCountersFromDailies`), and processing order is **date-ascending**. Penalty outcomes depend on the order days are evaluated. | The port must evaluate days in the same ascending order and derive counters the same way, or the 3-free-then-penalty sequence diverges. | Replicate (deterministic ordering in SQL) |
| **C-7** | `_lastPunch('OUT')` takes the **latest** OUT; `_firstPunch('IN')` takes the **earliest** IN. Multiple punches in a day collapse to (first IN, last OUT). | Duration and buckets use these extremes. Port must match. | Replicate |

**Parity harness must include:** at minimum one test per row above, plus the existing month-diff over real data. C-2 and C-3 in particular need a constructed month that crosses the free-allowance boundary.

---

## Appendix B — Endpoint mapping cheat-sheet (old → new)

| Old `Server_*` | New | Type |
|----------------|-----|------|
| `getUserInfo` | `GET /me` (session) | read |
| `getMyLastPunch` | `GET /me/last-punch` | read |
| `recordPunch` | `rpc: record_punch()` | **atomic write** |
| `getMyDashboard` | `GET /me/dashboard?month=` | read (no write-on-read) |
| `getAllLocations` | `GET /locations` | read |
| `getLeaveFormConfig` | `GET /leave/config` | read |
| `submitLeave` | `POST /leave` (+Storage upload) | write |
| `getMyLeaveRequests` | `GET /me/leaves` | read |
| `getTodayDashboard` | `GET /admin/today` | read |
| `getAdminReport` | `GET /admin/report?emp=&month=` | read |
| `getAllEmployees` / `addEmployee` / `updateEmployee` | `GET/POST/PATCH /admin/employees` | read/write |
| `getAllLocations` / `addLocation` | `GET/POST /admin/locations` | read/write |
| `getHolidayList` / `addHoliday` / `deleteHoliday` | `GET/POST/DELETE /admin/holidays` | read/write |
| `getAllPunchLogs` / `getTodayPunchLogs` | `GET /admin/punch-logs?scope=` | read |
| `getAllLeaveRequests` / `getTodayLeaveRequests` | `GET /admin/leaves?scope=` | read |
| `adminLeaveAction` | `PATCH /admin/leaves/:id` | write |

---

## Appendix D — UI reference (from live screenshots)

> Captured from the running Apps Script app. Phase 4 should reproduce this layout, wording, and the two distinct themes. Colours are approximate; exact tokens come from the current CSS during the port.

### D.1 Admin — light desktop dashboard
- **Header bar** (dark): app title "GPS ATTENDANCE — ADMIN"; signed-in admin email shown top-right (e.g. an `@gmail.com` admin account).
- **Top nav (8 tabs):** Today · Reports · Leave Requests · Punch Logs · Employees · Add Employee · Add Location · Holidays.
- **Today view:** "Today's Live Status — {date}", subtitle "Live snapshot… As of {HH:mm:ss}", a **Refresh** button, and an "auto-refresh every 5 min" note.
- **Off-day banner:** on Sundays/holidays a yellow banner — _"Today is a Sunday. Staff are not marked absent today."_ (matches `isOffDay` in `Server_getTodayDashboard`).
- **Tile grid (10 tiles), each = big count + label + sub-label, count colour-coded:**
  Total Staff (all active) · Present (punched in) · Yet to Punch (before grace) · Absent (past grace, no punch) · Late (in after 9:36) · On Leave (approved/pending) · In Office (head office) · In Workshop (workshop location) · WFH (work from home) · Other (field visit).
- **Scale seen:** Total Staff = **56**.
- Tiles are expandable to show the names in each bucket (from the `names[]` arrays the server returns).

### D.2 Staff — dark mobile PWA (punch view)
- **Header:** 📍 pin, "GPS ATTENDANCE", "Location-verified punch system", a **live ticking clock** and full date ("Sunday, 12 July 2026").
- **Welcome card:** "Welcome, {name}", the staff email (personal `@gmail.com` confirmed), an employee-type badge ("Fixed" / "Probation"), and a "Select Location" pill.
- **Location Rules** info box: "Select your current location below, then punch IN or OUT."
- **"SELECT YOUR CURRENT LOCATION *"** — tappable tiles, two per row. Live example set:
  Head Office (L1) · The Surya Hotel (L2) · Taj Suraj Kund (L3) · Eros (L4) · 🏠 Work From Home ("Valid if >5 km from office") · 🌍 Other / Field Visit ("Valid if >2 km from office").
  → confirms **multiple named workshop locations** (not just one) plus the two inverted-distance tiles; the geofence port must handle all of them.
- **GPS status line:** green dot + "GPS ready — {n}m accuracy" (turns amber/red on poor accuracy; punch blocked > 100 m per O8).
- **Last-punch line:** "No punch recorded yet." / "Last punch: {action} at {time}".
- **IN / OUT buttons** (below the fold in the screenshot) + a message area for accept/reject text.
- **Bottom tab bar:** PUNCH · DASHBOARD · LEAVE.
- **Note for cutover:** the current URL is `script.google.com` opened in mobile Safari (often from a WhatsApp link). After migration, staff get a clean Vercel URL — worth sending as an "Add to Home Screen" PWA link so it feels like an app.

---

_End of plan. Policy engine verified (Appendix A) with quirks catalogued (Appendix C); UI reference captured (Appendix D); scale confirmed (~56 active staff). Remaining inputs before Phase 3 locks: the Appendix C **Replicate/Fix** decisions (default = Replicate all), plus open questions 2–7 (logic placement, reverse-geocode, per-employee shift, parallel-run length, peak concurrency, and historical punch-row count). On your go-ahead I'll produce the Postgres schema DDL + the parity harness wired with the C-1…C-7 cases as the next deliverables._
