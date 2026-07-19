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
const EMP2_ID = 'T998';
const EMAIL2 = 'parity.harness.t998@example.com';
const ADMIN_EMAIL = 'parity.harness.admin@example.com';
const PASSWORD = 'Test-Parity-Harness-Pw-0021!';
const ZLOC = 'ZTEST';
let authUserId = null;
let authUserId2 = null;
let adminAuthUserId = null;
let user; // signed-in client (T999), used for most RPC calls below
let user2; // signed-in client (T998), for cross-employee device tests
let adminUser; // signed-in client whose email is in `admins`, for admin_mark_late
let originalEnforcement = 'off'; // app_config value to restore in cleanup

async function makeAuthUser(email) {
  const { data: created, error } = await admin.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true,
  });
  if (error) throw new Error(`setup: auth user create failed for ${email}: ` + error.message);
  const client = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error: signInErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (signInErr) throw new Error(`setup: sign-in failed for ${email}: ` + signInErr.message);
  return { id: created.user.id, client };
}

async function setup() {
  for (const id of [EMP_ID, EMP2_ID]) {
    await admin.from('attendance_summary').delete().eq('emp_id', id);
    await admin.from('punch_logs').delete().eq('emp_id', id);
    await admin.from('monthly_summary').delete().eq('emp_id', id);
    await admin.from('employee_devices').delete().eq('emp_id', id);
    await admin.from('employees').delete().eq('emp_id', id);
  }
  await admin.from('locations').delete().eq('location_id', ZLOC);
  await admin.from('admins').delete().eq('email', ADMIN_EMAIL);

  const { error: empErr } = await admin.from('employees').insert([
    { emp_id: EMP_ID, name: 'Parity Harness', email: EMAIL,
      employee_type: 'Fixed', assigned_location_id: 'L1', status: 'Active' },
    { emp_id: EMP2_ID, name: 'Parity Harness 2', email: EMAIL2,
      employee_type: 'Fixed', assigned_location_id: 'L1', status: 'Active' },
  ]);
  if (empErr) throw new Error('setup: employee insert failed: ' + empErr.message);

  const { error: admErr } = await admin.from('admins').insert({ email: ADMIN_EMAIL });
  if (admErr) throw new Error('setup: admins insert failed: ' + admErr.message);

  ({ id: authUserId, client: user } = await makeAuthUser(EMAIL));
  ({ id: authUserId2, client: user2 } = await makeAuthUser(EMAIL2));
  ({ id: adminAuthUserId, client: adminUser } = await makeAuthUser(ADMIN_EMAIL));

  const { data: cfg } = await admin.from('app_config').select('value').eq('key', 'device_enforcement').maybeSingle();
  originalEnforcement = cfg?.value ?? 'off';
}

async function cleanup() {
  for (const id of [EMP_ID, EMP2_ID]) {
    await admin.from('attendance_summary').delete().eq('emp_id', id);
    await admin.from('punch_logs').delete().eq('emp_id', id);
    await admin.from('monthly_summary').delete().eq('emp_id', id);
    await admin.from('employee_devices').delete().eq('emp_id', id);
    await admin.from('employees').delete().eq('emp_id', id);
  }
  await admin.from('locations').delete().eq('location_id', ZLOC);
  await admin.from('admins').delete().eq('email', ADMIN_EMAIL);
  await admin.from('app_config').update({ value: originalEnforcement }).eq('key', 'device_enforcement');
  if (authUserId) await admin.auth.admin.deleteUser(authUserId);
  if (authUserId2) await admin.auth.admin.deleteUser(authUserId2);
  if (adminAuthUserId) await admin.auth.admin.deleteUser(adminAuthUserId);
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

// ---------------------------------------------------------------------
// v2 Feature A -- strict 1:1 device binding in record_punch
// ---------------------------------------------------------------------
const ZLAT = 12.9716, ZLON = 77.5946;
const DEV1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const DEV2 = 'aaaaaaaa-0000-4000-8000-000000000002';

async function punch(client, action, deviceId) {
  const args = { p_action: action, p_location_id: ZLOC, p_lat: ZLAT, p_lon: ZLON, p_accuracy: 50 };
  if (deviceId !== undefined) {
    args.p_device_id = deviceId;
    args.p_user_agent = 'parity-harness';
  }
  const { data, error } = await client.rpc('record_punch', args);
  return { r: Array.isArray(data) ? data[0] : data, error };
}

// Resets the 2-min cooldown / IN-OUT sequence between punch tests without
// touching the device binding itself.
async function clearPunchState(empId) {
  await admin.from('punch_logs').delete().eq('emp_id', empId);
  await admin.from('attendance_summary').delete().eq('emp_id', empId);
}

async function setEnforcement(value) {
  const { error } = await admin.from('app_config').update({ value }).eq('key', 'device_enforcement');
  if (error) throw new Error('setEnforcement failed: ' + error.message);
}

async function testDeviceBinding() {
  const s = 'D: device binding';
  await admin.from('locations').delete().eq('location_id', ZLOC);
  await admin.from('locations').insert({ location_id: ZLOC, location_name: 'Z Test Site', latitude: ZLAT, longitude: ZLON, radius: 100 });
  await clearPunchState(EMP_ID);
  await clearPunchState(EMP2_ID);
  await setEnforcement('off');

  // Deploy safety: old clients (no p_device_id) keep punching while 'off'.
  const d1 = await punch(user, 'IN');
  check(s, "enforcement off + no device id -> punch succeeds (old clients unaffected)", !d1.error && d1.r?.success === true, d1);
  const { data: noBind } = await admin.from('employee_devices').select('emp_id').eq('emp_id', EMP_ID);
  check(s, 'no binding row created for device-less punch', (noBind ?? []).length === 0, { noBind });
  await clearPunchState(EMP_ID);

  // First punch with a device id auto-binds and logs the id per punch.
  const d2 = await punch(user, 'IN', DEV1);
  check(s, 'first punch with device id succeeds and auto-binds', !d2.error && d2.r?.success === true, d2);
  const { data: bind } = await admin.from('employee_devices').select('device_id').eq('emp_id', EMP_ID).maybeSingle();
  check(s, 'binding row holds DEV1', bind?.device_id === DEV1, { bind });
  const { data: logRow } = await admin.from('punch_logs').select('device_id').eq('emp_id', EMP_ID).order('log_id', { ascending: false }).limit(1).maybeSingle();
  check(s, 'punch_logs row records device_id (forensic trail)', logRow?.device_id === DEV1, { logRow });
  await clearPunchState(EMP_ID);

  // Same employee from a different device -> rejected, binding unchanged.
  const d3 = await punch(user, 'IN', DEV2);
  check(s, 'same employee, different device -> rejected', !d3.error && d3.r?.success === false && /different phone/i.test(d3.r?.message ?? ''), d3);
  const { data: bindAfter } = await admin.from('employee_devices').select('device_id').eq('emp_id', EMP_ID).maybeSingle();
  check(s, 'binding still DEV1 after rejected punch', bindAfter?.device_id === DEV1, { bindAfter });

  // Another employee on the SAME phone -> rejected (the buddy-punch case).
  const d4 = await punch(user2, 'IN', DEV1);
  check(s, "other employee using T999's phone -> rejected", !d4.error && d4.r?.success === false && /already registered/i.test(d4.r?.message ?? ''), d4);

  // Enforcement on: device-less punches stop working; the bound device still punches.
  await setEnforcement('on');
  const d5 = await punch(user, 'IN');
  check(s, 'enforcement on + no device id -> rejected', !d5.error && d5.r?.success === false && /refresh/i.test(d5.r?.message ?? ''), d5);
  const d6 = await punch(user, 'IN', DEV1);
  check(s, 'enforcement on + bound device -> succeeds', !d6.error && d6.r?.success === true, d6);
  await clearPunchState(EMP_ID);
  await setEnforcement('off');

  // Admin reset: delete the binding; next punch (new phone) auto-rebinds.
  await admin.from('employee_devices').delete().eq('emp_id', EMP_ID);
  const d7 = await punch(user, 'IN', DEV2);
  check(s, 'after admin reset, punch from new device succeeds and rebinds', !d7.error && d7.r?.success === true, d7);
  const { data: rebind } = await admin.from('employee_devices').select('device_id').eq('emp_id', EMP_ID).maybeSingle();
  check(s, 'binding now DEV2', rebind?.device_id === DEV2, { rebind });
  await clearPunchState(EMP_ID);
  await admin.from('employee_devices').delete().eq('emp_id', EMP_ID);
}

// ---------------------------------------------------------------------
// v2 Feature B -- admin_mark_late with full policy consequences
// ---------------------------------------------------------------------
async function markLate(empId, date, late, note) {
  const { data, error } = await adminUser.rpc('admin_mark_late', {
    p_emp_id: empId, p_date: date, p_late: late, p_note: note ?? null,
  });
  return { r: Array.isArray(data) ? data[0] : data, error };
}

async function getDay(date) {
  const { data } = await admin.from('attendance_summary').select('*').eq('emp_id', EMP_ID).eq('date', date).maybeSingle();
  return data;
}

async function testManualLateCore() {
  const s = 'ML: mark/unmark core';
  await clearPunchState(EMP_ID);
  await admin.from('monthly_summary').delete().eq('emp_id', EMP_ID);

  // One on-time day (same seeded-punch pattern as C-6/C-7), backfilled.
  await admin.from('punch_logs').insert([
    { emp_id: EMP_ID, action: 'IN', punched_at: '2026-07-01T09:30:00+05:30' },
    { emp_id: EMP_ID, action: 'OUT', punched_at: '2026-07-01T18:30:00+05:30' },
  ]);
  await user.rpc('backfill_missing_days', { p_emp_id: EMP_ID, p_month: '2026-07-01' });
  let day = await getDay('2026-07-01');
  check(s, 'baseline: on-time day evaluates Present, not late', day?.status === 'Present' && day?.late_flag === false, { day });

  const m1 = await markLate(EMP_ID, '2026-07-01', true, 'Workshop was 8 AM');
  check(s, 'mark late succeeds', !m1.error && m1.r?.success === true, m1);
  day = await getDay('2026-07-01');
  check(s, 'late_flag set, status still Present (1st late of month)', day?.late_flag === true && day?.status === 'Present', { day });
  check(s, 'manual columns recorded (flag, note, by-admin-email, timestamp)',
    day?.manual_late === true && day?.manual_late_note === 'Workshop was 8 AM' && day?.manual_late_by === ADMIN_EMAIL && !!day?.manual_late_at, { day });
  check(s, 'engine notes mention the admin mark', /marked late by admin/i.test(day?.notes ?? ''), { notes: day?.notes });

  // Note is optional: marking with no note must also work (one-tap flow).
  const m2 = await markLate(EMP_ID, '2026-07-01', true);
  check(s, 're-mark with no note succeeds and clears the old note', !m2.error && m2.r?.success === true && (await getDay('2026-07-01'))?.manual_late_note === null, m2);

  const m3 = await markLate(EMP_ID, '2026-07-01', false);
  check(s, 'unmark succeeds', !m3.error && m3.r?.success === true, m3);
  day = await getDay('2026-07-01');
  check(s, 'unmark restores: late_flag false, Present, manual columns cleared',
    day?.late_flag === false && day?.status === 'Present' && day?.manual_late === false && day?.manual_late_by === null && day?.manual_late_at === null, { day });
}

async function testManualLateConsequences() {
  const s = 'ML: allowance + cascade';
  await clearPunchState(EMP_ID);
  await admin.from('monthly_summary').delete().eq('emp_id', EMP_ID);

  // Real punches for four days: 07-01 on time; 07-02, 07-03, 07-07 late
  // (09:40). After backfill the three system lates are incidents 1..3 --
  // all inside the 3-free allowance, so everything is Present.
  await admin.from('punch_logs').insert([
    { emp_id: EMP_ID, action: 'IN', punched_at: '2026-07-01T09:30:00+05:30' },
    { emp_id: EMP_ID, action: 'OUT', punched_at: '2026-07-01T18:30:00+05:30' },
    { emp_id: EMP_ID, action: 'IN', punched_at: '2026-07-02T09:40:00+05:30' },
    { emp_id: EMP_ID, action: 'OUT', punched_at: '2026-07-02T18:30:00+05:30' },
    { emp_id: EMP_ID, action: 'IN', punched_at: '2026-07-03T09:40:00+05:30' },
    { emp_id: EMP_ID, action: 'OUT', punched_at: '2026-07-03T18:30:00+05:30' },
    { emp_id: EMP_ID, action: 'IN', punched_at: '2026-07-07T09:40:00+05:30' },
    { emp_id: EMP_ID, action: 'OUT', punched_at: '2026-07-07T18:30:00+05:30' },
  ]);
  await user.rpc('backfill_missing_days', { p_emp_id: EMP_ID, p_month: '2026-07-01' });
  let d7 = await getDay('2026-07-07');
  check(s, 'baseline: 3 system lates all within allowance -> 07-07 Present', d7?.status === 'Present' && d7?.late_flag === true, { d7 });

  // Retro-mark the on-time 07-01 as late. It becomes incident #1, pushing
  // 07-07 to incident #4 -- the forward cascade must convert it to Half Day.
  const m1 = await markLate(EMP_ID, '2026-07-01', true);
  check(s, 'retro mark on 07-01 succeeds', !m1.error && m1.r?.success === true, m1);
  const d1 = await getDay('2026-07-01');
  check(s, '07-01 itself: late but Present (incident #1)', d1?.late_flag === true && d1?.status === 'Present' && d1?.manual_late === true, { d1 });
  d7 = await getDay('2026-07-07');
  check(s, 'cascade: 07-07 becomes the 4th incident -> Half Day, 0.5 credit',
    d7?.status === 'Half Day' && Number(d7?.leave_credit_used) === 0.5, { d7 });

  // Marking an ALREADY-late day is a no-op on counters: 07-02 was late by
  // punch time; the mark records intent but flips nothing.
  const m2 = await markLate(EMP_ID, '2026-07-02', true, 'also missed workshop');
  const d2 = await getDay('2026-07-02');
  d7 = await getDay('2026-07-07');
  check(s, 'marking an already-late day changes nothing downstream',
    !m2.error && m2.r?.success === true && d2?.late_flag === true && d2?.manual_late === true && d7?.status === 'Half Day', { d2, d7 });

  // Unmark 07-01 -> 07-07 drops back to incident #3 -> Present again.
  await markLate(EMP_ID, '2026-07-02', false);
  const m3 = await markLate(EMP_ID, '2026-07-01', false);
  d7 = await getDay('2026-07-07');
  check(s, 'unmark reverses the cascade: 07-07 back to Present', !m3.error && m3.r?.success === true && d7?.status === 'Present', { d7 });
}

async function testManualLateGuards() {
  const s = 'ML: guards';

  const g1 = await user.rpc('admin_mark_late', { p_emp_id: EMP_ID, p_date: '2026-07-01', p_late: true, p_note: null });
  check(s, 'non-admin caller -> permission error', !!g1.error && /admin access only/i.test(g1.error.message), g1.error?.message);

  const g2 = await markLate(EMP_ID, '2026-07-18', true); // backfilled Absent row, no punch IN
  check(s, 'day without a punch IN -> rejected', !g2.error && g2.r?.success === false && /no punch in/i.test(g2.r?.message ?? ''), g2);

  const g3 = await markLate(EMP_ID, '2026-07-05', true); // a Sunday
  check(s, 'Sunday -> rejected', !g3.error && g3.r?.success === false && /sunday/i.test(g3.r?.message ?? ''), g3);

  const g4 = await markLate(EMP_ID, '2026-12-01', true);
  check(s, 'future date -> rejected', !g4.error && g4.r?.success === false && /future/i.test(g4.r?.message ?? ''), g4);

  // Holiday guard: use a temporary holiday on a date we control, unless one
  // already exists there (then just use it as-is).
  const HDATE = '2026-07-14';
  const { data: existing } = await admin.from('holidays').select('date').eq('date', HDATE).maybeSingle();
  if (!existing) await admin.from('holidays').insert({ date: HDATE, holiday_name: 'Parity Harness Holiday' });
  const g5 = await markLate(EMP_ID, HDATE, true);
  check(s, 'holiday -> rejected', !g5.error && g5.r?.success === false && /holiday/i.test(g5.r?.message ?? ''), g5);
  if (!existing) await admin.from('holidays').delete().eq('date', HDATE).eq('holiday_name', 'Parity Harness Holiday');
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
    await testDeviceBinding();
    await testManualLateCore();
    await testManualLateConsequences();
    await testManualLateGuards();
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
