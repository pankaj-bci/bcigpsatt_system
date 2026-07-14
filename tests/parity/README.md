# Parity harness (Phase 3, Task 10)

`.claude/plan.md` Section 9 requires every ported module to have "a test
that proves it matches the old output," and Appendix C requires "at minimum
one test per row" (C-1 through C-8). This directory is the complete gate —
see "What it does NOT do" below for why it isn't a real-data diff.

## What `run.mjs` does

Runs `node tests/parity/run.mjs` from the project root against the live
Supabase project in `.env.local`. It:

- Exercises the exact boundary values named in Appendix A (GPS accuracy
  99/100/101m; the 09:36/09:37/11:00/14:00 IN cut-points; the
  18:30/17:00/14:00 OUT cut-points).
- Has one dedicated test per Appendix C quirk (C-1..C-8), each asserting
  the specific documented behaviour, not a "fixed" version of it.
- Is safe to re-run any time: everything is either a pure RPC call (no
  write) or a synthetic fixture under one dedicated test employee (`T999`)
  and one temporary location (`ZTEST`), fully deleted in a `finally` block
  even on failure.

## What it does NOT do

It does not compare against the real old system's historical output. Section
9 originally called for that (export old MONTHLY_SUMMARY/ATTENDANCE_SUMMARY,
diff byte-for-byte against the new engine fed the same PUNCH_LOGS) — but
Phase 2 narrowed the migration scope to the `employees` table only.
Punch/attendance/leave history is deliberately not carried over; the new
system starts clean from cutover instead of running parallel to the old one.
There is no real historical dataset left to diff against, so that gate was
retired and this synthetic suite (spec-accurate boundary values + every
documented quirk) is the actual parity gate for O6.
