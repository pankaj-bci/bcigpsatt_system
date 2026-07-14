// Phase 5, Task 2: concurrency load test for record_punch() -- O1 (punch
// API p95 < 800ms) and O2 (0 "busy"/timeout errors, 100% success at >=56
// concurrent punches, matching full active staff headcount) from
// .claude/plan.md Section 4.
//
// Mirrors tests/parity/run.mjs's fixture pattern: everything created here
// (LOAD001..LOADxxx employees, their auth users, their punch_logs /
// attendance_summary rows) is deleted in cleanup(), success or failure.
// Never touches real employee data.
//
// Run: node tests/load/run.mjs [concurrency]   (default concurrency: 56)

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

const N = parseInt(process.argv[2], 10) || 56;
const PASSWORD = 'Test-Load-Harness-Pw-0021!';
const LOC_ID = 'L1';

const admin = createClient(URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });

const empId = (i) => `LOAD${String(i).padStart(3, '0')}`;
const email = (i) => `load.harness.${String(i).padStart(3, '0')}@example.com`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let authUserIds = [];
let userClients = [];

async function wipeFixtures() {
  const ids = Array.from({ length: N }, (_, i) => empId(i + 1));
  await admin.from('attendance_summary').delete().in('emp_id', ids);
  await admin.from('punch_logs').delete().in('emp_id', ids);
  await admin.from('monthly_summary').delete().in('emp_id', ids);
  await admin.from('employees').delete().in('emp_id', ids);
  // auth users: list + delete any leftover from a prior failed run
  let page = 1;
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error('wipeFixtures: listUsers failed: ' + error.message);
    const stale = data.users.filter((u) => u.email && u.email.startsWith('load.harness.'));
    for (const u of stale) await admin.auth.admin.deleteUser(u.id);
    if (data.users.length < 200) break;
    page++;
  }
}

async function setup() {
  console.log(`Setting up ${N} temporary employees + auth users...`);
  await wipeFixtures();

  const { data: loc, error: locErr } = await admin
    .from('locations')
    .select('latitude, longitude')
    .eq('location_id', LOC_ID)
    .single();
  if (locErr) throw new Error('setup: could not read location ' + LOC_ID + ': ' + locErr.message);

  const rows = Array.from({ length: N }, (_, idx) => ({
    emp_id: empId(idx + 1),
    name: `Load Harness ${idx + 1}`,
    email: email(idx + 1),
    employee_type: 'Fixed',
    assigned_location_id: LOC_ID,
    status: 'Active',
  }));
  const { error: empErr } = await admin.from('employees').insert(rows);
  if (empErr) throw new Error('setup: employee bulk insert failed: ' + empErr.message);

  for (let idx = 0; idx < N; idx++) {
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: email(idx + 1), password: PASSWORD, email_confirm: true,
    });
    if (createErr) throw new Error(`setup: auth user create failed for ${email(idx + 1)}: ` + createErr.message);
    authUserIds.push(created.user.id);
  }

  // GoTrue rate-limits signInWithPassword per-project/per-IP; a tight
  // sequential loop of 56 sign-ins can trip it well before N is reached.
  // This only slows down SETUP -- the actual concurrent-punch measurement
  // only starts once every client below has a session, so pacing/retrying
  // here doesn't affect O1/O2 results at all.
  async function signInWithRetry(client, mail, attempt = 1) {
    const { error } = await client.auth.signInWithPassword({ email: mail, password: PASSWORD });
    if (!error) return;
    if (/rate limit/i.test(error.message) && attempt <= 10) {
      const wait = Math.min(2000 * attempt, 15000);
      console.log(`  rate limited signing in ${mail}, retrying in ${wait}ms (attempt ${attempt})`);
      await sleep(wait);
      return signInWithRetry(client, mail, attempt + 1);
    }
    throw new Error(`setup: sign-in failed for ${mail}: ` + error.message);
  }

  userClients = [];
  for (let idx = 0; idx < N; idx++) {
    const client = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } });
    await signInWithRetry(client, email(idx + 1));
    userClients.push(client);
    await sleep(300); // stay under the burst threshold instead of racing into it
  }

  console.log(`Setup complete. Location ${LOC_ID} at (${loc.latitude}, ${loc.longitude}).`);
  return loc;
}

async function cleanup() {
  console.log('Cleaning up...');
  const ids = Array.from({ length: N }, (_, i) => empId(i + 1));
  await admin.from('attendance_summary').delete().in('emp_id', ids);
  await admin.from('punch_logs').delete().in('emp_id', ids);
  await admin.from('monthly_summary').delete().in('emp_id', ids);
  await admin.from('employees').delete().in('emp_id', ids);
  for (const id of authUserIds) await admin.auth.admin.deleteUser(id);
  console.log('Cleanup complete.');
}

function percentile(sorted, p) {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

async function fireRound(label, action, loc) {
  console.log(`\nFiring ${N} concurrent record_punch('${action}') calls [${label}]...`);
  const t0 = Date.now();
  const results = await Promise.all(
    userClients.map(async (client) => {
      const start = Date.now();
      const { data, error } = await client.rpc('record_punch', {
        p_action: action,
        p_location_id: LOC_ID,
        p_lat: loc.latitude,
        p_lon: loc.longitude,
        p_accuracy: 10,
      });
      const ms = Date.now() - start;
      if (error) return { ok: false, ms, message: error.message };
      const row = Array.isArray(data) ? data[0] : data;
      return { ok: !!row?.success, ms, message: row?.message };
    })
  );
  const wallMs = Date.now() - t0;

  const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const max = latencies[latencies.length - 1];
  const successes = results.filter((r) => r.ok);
  const failures = results.filter((r) => !r.ok);
  const busyOrTimeout = failures.filter((r) =>
    /busy|timeout|lock|deadlock|could not serialize/i.test(r.message || '')
  );

  console.log(`--- Load test results [${label}] ---`);
  console.log(`Concurrency: ${N}`);
  console.log(`Wall clock for all ${N} calls to resolve: ${wallMs}ms`);
  console.log(`Latency (ms): p50=${p50} p95=${p95} max=${max}`);
  console.log(`Success: ${successes.length}/${N}`);
  console.log(`Failures: ${failures.length}/${N}`);
  if (failures.length) {
    console.log('Failure messages (first 10):');
    for (const f of failures.slice(0, 10)) console.log(`  - ${f.message}`);
  }
  console.log(`Busy/timeout/lock-contention failures: ${busyOrTimeout.length}`);

  return { p50, p95, max, successes, failures, busyOrTimeout };
}

async function runLoadTest(loc) {
  // Round 1 ("cold"): each client's very first request on a just-opened
  // session/connection -- this is what a real 9:30 AM rush looks like
  // (everyone's phone opens the app and punches within the same minute).
  const cold = await fireRound('cold, IN', 'IN', loc);
  // Round 2 ("warm"): same 56 already-authenticated clients, connections
  // already established -- isolates connection/session ramp-up cost from
  // record_punch()'s own execution cost. If warm is much faster than cold,
  // the O1 bottleneck is client/connection setup, not the RPC or DB.
  // record_punch()'s anti-fraud cooldown (20260713050000_anti_fraud.sql)
  // rejects any punch within 2 minutes of the last one for that employee,
  // so this round has to wait it out or every "warm" call is a rejected
  // no-op instead of a real comparable request.
  console.log('\nWaiting out the 2-minute anti-fraud cooldown before the warm round...');
  await sleep(125_000);
  const warm = await fireRound('warm, OUT', 'OUT', loc);

  // Row-consistency check: exactly two punch_logs rows (IN then OUT) and
  // one attendance_summary row (upserted) per employee -- no duplicates,
  // no missing rows, across BOTH rounds.
  const ids = Array.from({ length: N }, (_, i) => empId(i + 1));
  const { data: punchRows, error: punchErr } = await admin
    .from('punch_logs')
    .select('emp_id')
    .in('emp_id', ids);
  if (punchErr) throw new Error('verify: punch_logs read failed: ' + punchErr.message);
  const punchCounts = new Map();
  for (const r of punchRows) punchCounts.set(r.emp_id, (punchCounts.get(r.emp_id) || 0) + 1);
  const wrongPunchCounts = ids.filter((id) => (punchCounts.get(id) || 0) !== 2);

  const { data: summaryRows, error: summaryErr } = await admin
    .from('attendance_summary')
    .select('emp_id')
    .in('emp_id', ids);
  if (summaryErr) throw new Error('verify: attendance_summary read failed: ' + summaryErr.message);
  const summaryCounts = new Map();
  for (const r of summaryRows) summaryCounts.set(r.emp_id, (summaryCounts.get(r.emp_id) || 0) + 1);
  const dupSummaries = [...summaryCounts.entries()].filter(([, c]) => c > 1);

  console.log(`\nEmployees without exactly 2 punch_logs rows (IN+OUT): ${wrongPunchCounts.length}`);
  console.log(`Duplicate attendance_summary rows (should be impossible -- unique (emp_id,date)): ${dupSummaries.length}`);

  const successes = cold.successes.length + warm.successes.length;
  const busyOrTimeout = cold.busyOrTimeout.length + warm.busyOrTimeout.length;
  const o1Pass = cold.p95 < 800 && warm.p95 < 800;
  const o2Pass = busyOrTimeout === 0 && successes === 2 * N;
  console.log('\n--- Exit metrics ---');
  console.log(`O1 (punch API p95 < 800ms): ${o1Pass ? 'PASS' : 'FAIL'} (cold p95=${cold.p95}ms, warm p95=${warm.p95}ms)`);
  console.log(`O2 (0 busy errors, 100% success @ >=${N} concurrent): ${o2Pass ? 'PASS' : 'FAIL'}`);

  return o1Pass && o2Pass && wrongPunchCounts.length === 0 && dupSummaries.length === 0;
}

async function main() {
  let ok = false;
  try {
    const loc = await setup();
    ok = await runLoadTest(loc);
  } finally {
    await cleanup();
  }
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('Load test crashed:', err);
  cleanup().finally(() => process.exit(1));
});
