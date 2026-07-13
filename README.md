# BCI Attendance App

GPS attendance system for BCI — migrated from Google Sheets + Apps Script to
Supabase (Postgres + Auth + Storage) + Next.js on Vercel.

The full migration plan (problem statement, target architecture, business-logic
spec, phased execution plan) lives in **`.claude/plan.md`** on the machine this
was authored on. That file is git-ignored (local-only, not in this repo) — if
you're reading this from a fresh clone, that document does not exist for you;
ask the repo owner for a copy.

## Repo layout

```
/legacy-apps-script   old Google Apps Script source (reference only, for parity testing)
/.claude/plan.md      the migration plan (local-only, git-ignored — not in this repo)
/src/app              Next.js App Router pages (staff + admin)
/lib/supabase         Supabase client helpers
/lib/geo              haversine / geofence utilities
/lib/policy           ported attendance policy engine
/supabase/migrations  DDL: tables, enums, indexes, RLS, RPC functions
/supabase/tests/parity  parity test vectors (old vs new must match exactly)
```

## Local setup

```bash
npm install
cp .env.example .env.local   # then fill in real Supabase values
npm run dev
```

Open http://localhost:3000

## Stack

- Next.js (App Router) + TypeScript + Tailwind, deployed on Vercel
- Supabase: Postgres, Auth (Google OAuth), Storage, pg_cron
