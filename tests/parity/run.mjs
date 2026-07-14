// Phase 3, Task 10: parity harness -- Appendix A boundary matrix + one
// automated test per Appendix C quirk (C-1..C-8), run directly against the
// live Supabase RPCs.
//
// This IS the full O6 parity gate, not half of one: the originally-planned
// real-data diff against the old system's MONTHLY_SUMMARY/ATTENDANCE_SUMMARY
// was superseded by the Phase 2 decision to migrate the employees table
// only -- no historical punch/attendance/leave data is carried over, so
// there's no real dataset to diff against. See tests/parity/README.md.
//
// Run: node tests/parity/run.mjs   (from the project root, so node_modules
// resolves and .env.local is found).
//
// Safe to re-run any time: everything it touches is either a pure function
// call (no DB write) or created-and-deleted synthetic fixtures under a
// dedicated test employee (T999) + one temporary location (ZTEST). It never
// reads or writes real employee data.

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

const admin = createClient(URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });
const anonBase = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } });

let pass = 0, fail = 0;
const failures = [];
function check(section, name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`PASS [${section}] ${name}`);
  } else {
    fail++;
    failures.push(`[${section}] ${name}`);
    console.log(`FAIL [${section}] ${name}${extra ? ' -- ' + JSON.stringify(extra) : ''}`);
  }
}

const EMP_ID = 'T999';
const EMAIL = 'parity.harness.t999@example.com';
const PASSWORD = 'Test-Parity-Harness-Pw-0021!';
const ZLOC = 'ZTEST';
let authUserId = null;
let user; // signed-in client, used for every RPC call below

async function setup() {
  await admin.from('attendance_summary').delete().eq('emp_id', EMP_ID);
  await admin.from('punch_logs').delete().eq('emp_id', EMP_ID);
  await admin.from('monthly_summary').delete().eq('emp_id', EMP_ID);
  await admin.from('employees').delete().eq('emp_id', EMP_ID);
  await admin.from('locations').delete().eq('location_id', ZLOC);

  const { error: empErr } = await admin.from('employees').insert({
    emp_id: EMP_ID, name: 'Parity Harness', email: EMAIL,
    employee_type: 'Fixed', assigned_location_id: 'L1', status: 'Active',
  });
  if (empErr) throw new Error('setup: employee insert failed: ' + empErr.message);

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: EMAIL, password: PASSWORD, email_confirm: true,
  });
  if (createErr) throw new Error('setup: auth user create failed: ' + createErr.message);
  authUserId = created.user.id;

  user = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error: signInErr } = await user.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (signInErr) throw new Error('setup: sign-in failed: ' + signInErr.message);
}

async function cleanup() {
  await admin.from('attendance_summary').delete().eq('emp_id', EMP_ID);
  await admin.from('punch_logs').delete().eq('emp_id', EMP_ID);
  await admin.from('monthly_summary').delete().eq('emp_id', EMP_ID);
  await admin.from('employees').delete().eq('emp_id', EMP_ID);
  await admin.from('locations').delete().eq('location_id', ZLOC);
  if (authUserId) await admin.auth.admin.deleteUser(authUserId);
}

// ---------------------------------------------------------------------
// Appendix A -- boundary value matrix
// ---------------------------------------------------------------------
async function testAppendixA_gpsAccuracy() {
  const s = 'A: GPS accuracy';
  for (const [val, expected] of [[99, true], [100, true], [101, false], [0, false], [null, false]]) {
    const { data, error } = await user.rpc('is_gps_accuracy_valid', { accuracy_meters: val });
    check(s, `${val}m -> ${expected}`, !error && data === expected, { data, error });
  }
}

async function testAppendixA_inBoundaries() {
  const s = 'A: IN classification boundaries';
  const cases = [
    ['09:36:00', { late: false, halfDay: false, status: 'Present' }],
    ['09:37:00', { late: true, halfDay: false, status: 'Present' }],
    ['11:00:00', { late: true, halfDay: false, status: 'Present' }],
    ['11:01:00', { late: false, halfDay: true, status: 'Half Day' }],
    ['13:59:00', { late: false, halfDay: true, status: 'Half Day' }],
    ['14:00:00', { late: false, halfDay: false, status: 'Absent' }],
  ];
  for (const [inTime, exp] of cases) {
    const { data, error } = await user.rpc('evaluate_fixed', {
      p_first_in: inTime, p_last_out: '18:30:00', p_monthly_late_early_used: 0, p_monthly_leave_credits_used: 0,
    });
    const r = Array.isArray(data) ? data[0] : data;
    check(s, `IN ${inTime} -> ${exp.status} (late=${exp.late}, halfDay=${exp.halfDay})`,
      !error && r?.status === exp.status && r?.late_flag === exp.late && r?.half_day_flag === exp.halfDay, { r, error });
  }
}

async function testAppendixA_outBoundaries() {
  const s = 'A: OUT classification boundaries';
  const cases = [
    ['18:30:00', { early: false, halfDay: false, status: 'Present' }],
    ['18:29:00', { early: true, halfDay: false, status: 'Present' }],
    ['17:00:00', { early: true, halfDay: false, status: 'Present' }],
    ['16:59:00', { early: false, halfDay: true, status: 'Half Day' }],
    ['14:00:00', { early: false, halfDay: true, status: 'Half Day' }],
    ['13:59:00', { early: false, halfDay: false, status: 'Absent' }],
  ];
  for (const [outTime, exp] of cases) {
    const { data, error } = await user.rpc('evaluate_fixed', {
      p_first_in: '09:30:00', p_last_out: outTime, p_monthly_late_early_used: 0, p_monthly_leave_credits_used: 0,
    });
    const r = Array.isArray(data) ? data[0] : data;
    check(s, `OUT ${outTime} -> ${exp.status} (early=${exp.early}, halfDay=${exp.halfDay})`,
      !error && r?.status === exp.status && r?.early_flag === exp.early && r?.half_day_flag === exp.halfDay, { r, error });
  }
}

// ---------------------------------------------------------------------
// Appendix C -- one test per quirk
// ---------------------------------------------------------------------
async function testC1() {
  const s = 'C-1: OUT-absent suppressed when IN already half-day';
  const { data: halfDayCase, error: e1 } = await user.rpc('evaluate_fixed', {
    p_first_in: '13:00:00', p_last_out: '13:30:00', p_monthly_late_early_used: 0, p_monthly_leave_credits_used: 0,
  });
  const r1 = Array.isArray(halfDayCase) ? halfDayCase[0] : halfDayCase;
  check(s, 'late-half-day IN (13:00) + early OUT (13:30) -> Half Day, NOT Absent', !e1 && r1?.status === 'Half Day', { r1, e1 });

  const { data: ontimeCase, error: e2 } = await user.rpc('evaluate_fixed', {
    p_first_in: '09:30:00', p_last_out: '13:30:00', p_monthly_late_early_used: 0, p_monthly_leave_credits_used: 0,
  });
  const r2 = Array.isArray(ontimeCase) ? ontimeCase[0] : ontimeCase;
  check(s, 'on-time IN (09:30) + same OUT (13:30) -> Absent (asymmetry proven)', !e2 && r2?.status === 'Absent', { r2, e2 });
}

async function testC2() {
  const s = 'C-2: late/early penalty ignores remaining-credit guard';
  const { data: penalty, error: e1 } = await user.rpc('evaluate_fixed', {
    p_first_in: '09:40:00', p_last_out: '18:30:00', p_monthly_late_early_used: 3, p_monthly_leave_credits_used: 1,
  });
  const r1 = Array.isArray(penalty) ? penalty[0] : penalty;
  check(s, '4th late incident deducts 0.5 credit even though credits_used already == limit (1)',
    !e1 && r1?.status === 'Half Day' && Number(r1?.leave_credit_used) === 0.5, { r1, e1 });

  const { data: bucket, error: e2 } = await user.rpc('evaluate_fixed', {
    p_first_in: '13:00:00', p_last_out: '18:30:00', p_monthly_late_early_used: 0, p_monthly_leave_credits_used: 1,
  });
  const r2 = Array.isArray(bucket) ? bucket[0] : bucket;
  check(s, 'contrast: bucket-driven Half Day (late IN itself) DOES guard -- 0 credit deducted when already at limit',
    !e2 && r2?.status === 'Half Day' && Number(r2?.leave_credit_used) === 0, { r2, e2 });
}

async function testC3() {
  const s = 'C-3: reported delta vs the threshold decision disagree';
  const { data: noConv, error: e1 } = await user.rpc('evaluate_fixed', {
    p_first_in: '09:40:00', p_last_out: '17:30:00', p_monthly_late_early_used: 0, p_monthly_leave_credits_used: 0,
  });
  const r1 = Array.isArray(noConv) ? noConv[0] : noConv;
  check(s, 'both violations, no conversion -> late_early_delta reported as 2',
    !e1 && r1?.late_flag === true && r1?.early_flag === true && r1?.half_day_flag === false && r1?.status === 'Present' && r1?.late_early_delta === 2, { r1, e1 });

  const { data: conv, error: e2 } = await user.rpc('evaluate_fixed', {
    p_first_in: '09:40:00', p_last_out: '17:30:00', p_monthly_late_early_used: 3, p_monthly_leave_credits_used: 0,
  });
  const r2 = Array.isArray(conv) ? conv[0] : conv;
  check(s, 'same both-violation day, but 4th-incident threshold hit -> delta stays 1 (decision only used +1), NOT 2',
    !e2 && r2?.late_flag === true && r2?.early_flag === true && r2?.half_day_flag === true && r2?.status === 'Half Day' && r2?.late_early_delta === 1, { r2, e2 });
}

async function testC4() {
  const s = 'C-4: Punch In Only vanishes from monthly totals';
  const { data: dayEval, error: e1 } = await user.rpc('evaluate_day', {
    p_employee_type: 'Fixed', p_date: '2026-07-08', p_has_any_punch: true,
    p_first_in: '09:30:00', p_last_out: null, p_is_holiday: false, p_holiday_name: null,
  });
  const r1 = Array.isArray(dayEval) ? dayEval[0] : dayEval;
  check(s, 'IN with no OUT classifies as "Punch In Only", 0 credit used', !e1 && r1?.status === 'Punch In Only' && Number(r1?.leave_credit_used) === 0, { r1, e1 });

  // Live rollup check: seed one Punch In Only day among known-status days,
  // confirm it counts toward neither total_present nor total_absent.
  await admin.from('attendance_summary').insert([
    { emp_id: EMP_ID, date: '2026-07-08', status: 'Punch In Only', in_time: '09:30:00', out_time: null, leave_credit_used: 0 },
    { emp_id: EMP_ID, date: '2026-07-09', status: 'Present', in_time: '09:30:00', out_time: '18:30:00', leave_credit_used: 0 },
  ]);
  const { data: summary, error: e2 } = await user.rpc('generate_monthly_summary', { p_emp_id: EMP_ID, p_month: '2026-07-01' });
  const rs = Array.isArray(summary) ? summary[0] : summary;
  check(s, 'monthly rollup: 1 Present + 1 Punch In Only -> total_present == 1, total_absent == 0',
    !e2 && rs?.total_present === 1 && rs?.total_absent === 0, { rs, e2 });
}

async function testC5() {
  const s = 'C-5: Working Holiday excluded from total_present, included in extra-days';
  await admin.from('attendance_summary').delete().eq('emp_id', EMP_ID);
  await admin.from('monthly_summary').delete().eq('emp_id', EMP_ID);
  await admin.from('attendance_summary').insert([
    { emp_id: EMP_ID, date: '2026-07-08', status: 'Working Holiday', in_time: '09:00:00', out_time: '14:00:00', leave_credit_used: 0 }, // 5h -> +1 extra day
    { emp_id: EMP_ID, date: '2026-07-09', status: 'Present', in_time: '09:30:00', out_time: '18:30:00', leave_credit_used: 0 },
  ]);
  const { data: summary, error: e1 } = await user.rpc('generate_monthly_summary', { p_emp_id: EMP_ID, p_month: '2026-07-01' });
  const rs = Array.isArray(summary) ? summary[0] : summary;
  check(s, 'monthly rollup: Working Holiday day excluded -> total_present == 1 (just the Present day)',
    !e1 && rs?.total_present === 1, { rs, e1 });

  const { data: extra, error: e2 } = await user.rpc('get_extra_days_yearly', { p_emp_id: EMP_ID, p_year: 2026 });
  check(s, 'yearly extra-days: same Working Holiday day IS counted -> 1', !e2 && Number(extra) === 1, { extra, e2 });
}

async function testC6() {
  const s = 'C-6: date-ascending sequential counters (3-free-then-penalty boundary)';
  await admin.from('attendance_summary').delete().eq('emp_id', EMP_ID);
  await admin.from('punch_logs').delete().eq('emp_id', EMP_ID);
  // Seed exactly 2 late/early already used earlier in the month...
  await admin.from('attendance_summary').insert([
    { emp_id: EMP_ID, date: '2026-07-01', status: 'Present', late_flag: true, in_time: '09:40:00', out_time: '18:30:00', leave_credit_used: 0 },
    { emp_id: EMP_ID, date: '2026-07-02', status: 'Present', late_flag: true, in_time: '09:40:00', out_time: '18:30:00', leave_credit_used: 0 },
  ]);
  // ...then two more late-IN days with real punches, backfilled in one run --
  // day 3 (3rd incident) should stay free, day 4 (4th) should convert.
  await admin.from('punch_logs').insert([
    { emp_id: EMP_ID, action: 'IN', punched_at: '2026-07-03T09:40:00+05:30' },
    { emp_id: EMP_ID, action: 'OUT', punched_at: '2026-07-03T18:30:00+05:30' },
    { emp_id: EMP_ID, action: 'IN', punched_at: '2026-07-06T09:40:00+05:30' },
    { emp_id: EMP_ID, action: 'OUT', punched_at: '2026-07-06T18:30:00+05:30' },
  ]);
  const { error: bfErr } = await user.rpc('backfill_missing_days', { p_emp_id: EMP_ID, p_month: '2026-07-01' });
  check(s, 'backfill RPC succeeds', !bfErr, bfErr);

  const { data: rows } = await admin.from('attendance_summary').select('date, status').eq('emp_id', EMP_ID).order('date');
  const day3 = rows?.find((r) => r.date === '2026-07-03');
  const day4 = rows?.find((r) => r.date === '2026-07-06');
  check(s, '3rd incident (seeded 2 + this day) stays free -> Present', day3?.status === 'Present', { day3 });
  check(s, '4th incident crosses the boundary -> Half Day', day4?.status === 'Half Day', { day4 });
}

async function testC7() {
  const s = 'C-7: multiple punches collapse to (earliest IN, latest OUT)';
  await admin.from('attendance_summary').delete().eq('emp_id', EMP_ID);
  await admin.from('punch_logs').delete().eq('emp_id', EMP_ID);
  // Messy day: an out-of-order duplicate IN and an extra OUT, inserted directly
  // (bypassing anti-fraud, same as old raw sheet data could contain).
  // Must be a day strictly before "today" -- backfill never processes
  // today/future days (same cutoff proven in Task 6).
  await admin.from('punch_logs').insert([
    { emp_id: EMP_ID, action: 'IN', punched_at: '2026-07-11T09:00:00+05:30' },
    { emp_id: EMP_ID, action: 'IN', punched_at: '2026-07-11T09:15:00+05:30' },
    { emp_id: EMP_ID, action: 'OUT', punched_at: '2026-07-11T13:00:00+05:30' },
    { emp_id: EMP_ID, action: 'OUT', punched_at: '2026-07-11T18:45:00+05:30' },
  ]);
  const { error: bfErr } = await user.rpc('backfill_missing_days', { p_emp_id: EMP_ID, p_month: '2026-07-01' });
  check(s, 'backfill RPC succeeds', !bfErr, bfErr);

  const { data: row } = await admin.from('attendance_summary').select('in_time, out_time').eq('emp_id', EMP_ID).eq('date', '2026-07-11').single();
  check(s, 'first_in == 09:00 (earliest IN, not the duplicate 09:15)', row?.in_time?.slice(0, 5) === '09:00', { row });
  check(s, 'last_out == 18:45 (latest OUT, not the first 13:00)', row?.out_time?.slice(0, 5) === '18:45', { row });
}

async function testC8() {
  const s = 'C-8: geofence validates the selected tile, not assigned_location_id';
  await admin.from('locations').delete().eq('location_id', ZLOC);
  await admin.from('locations').insert({ location_id: ZLOC, location_name: 'Z Test Site', latitude: 12.9716, longitude: 77.5946, radius: 100 });
  // Employee is assigned to L1, but selects ZTEST and is physically at ZTEST's coords.
  const { data: selected, error: e1 } = await user.rpc('validate_punch_location', {
    p_action: 'IN', p_location_id: ZLOC, p_assigned_location_id: 'L1', p_lat: 12.9716, p_lon: 77.5946,
  });
  const r1 = Array.isArray(selected) ? selected[0] : selected;
  check(s, 'validates against the SELECTED tile (ZTEST), succeeds despite being far from assigned L1', !e1 && r1?.valid === true, { r1, e1 });

  // No tile selected (null) -> falls back to assigned_location_id.
  const { data: office } = await admin.from('locations').select('latitude, longitude').eq('location_id', 'L1').single();
  const { data: fallback, error: e2 } = await user.rpc('validate_punch_location', {
    p_action: 'IN', p_location_id: null, p_assigned_location_id: 'L1', p_lat: office.latitude, p_lon: office.longitude,
  });
  const r2 = Array.isArray(fallback) ? fallback[0] : fallback;
  check(s, 'null selected tile falls back to assigned_location_id (L1), succeeds when physically at L1', !e2 && r2?.valid === true, { r2, e2 });
}

async function main() {
  try {
    await setup();
    await testAppendixA_gpsAccuracy();
    await testAppendixA_inBoundaries();
    await testAppendixA_outBoundaries();
    await testC1();
    await testC2();
    await testC3();
    await testC4();
    await testC5();
    await testC6();
    await testC7();
    await testC8();
  } catch (e) {
    fail++;
    failures.push('(exception)');
    console.log('FAIL (exception) -- ' + e.message);
  } finally {
    await cleanup();
    const { count: summaryCount } = await admin.from('attendance_summary').select('*', { count: 'exact', head: true }).eq('emp_id', EMP_ID);
    const { count: punchCount } = await admin.from('punch_logs').select('*', { count: 'exact', head: true }).eq('emp_id', EMP_ID);
    const { count: empCount } = await admin.from('employees').select('*', { count: 'exact', head: true }).eq('emp_id', EMP_ID);
    const { count: locCount } = await admin.from('locations').select('*', { count: 'exact', head: true }).eq('location_id', ZLOC);
    console.log(`\ncleanup check: attendance_summary=${summaryCount}, punch_logs=${punchCount}, employees=${empCount}, locations(ZTEST)=${locCount} (all should be 0)`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) console.log('Failures:\n  ' + failures.join('\n  '));
  process.exit(fail > 0 ? 1 : 0);
}

main();
