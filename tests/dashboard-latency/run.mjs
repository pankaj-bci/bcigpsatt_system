// Phase 5, Task 3: admin Today dashboard latency -- O1's other half
// (dashboard API p95 < 400ms, .claude/plan.md Section 4). Replicates the
// exact 4-query Promise.all from src/app/admin/today-data.ts's
// getTodayDashboard() against a signed-in temp admin, run N times
// sequentially (this is a single admin loading/refreshing the page, not a
// concurrency test -- that's tests/load/run.mjs's job).
//
// Run: node tests/dashboard-latency/run.mjs [iterations]   (default: 30)

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

const N = parseInt(process.argv[2], 10) || 30;
const ADMIN_EMAIL = 'dashboard.latency.harness@example.com';
const PASSWORD = 'Test-Dashboard-Latency-Pw-0021!';

const admin = createClient(URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });

function percentile(sorted, p) {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

// Mirrors getISTNowParts() from lib/date.ts closely enough for a day-boundary query.
function todayIST() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).formatToParts(new Date());
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  const d = parts.find((p) => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

async function setup() {
  await admin.from('admins').delete().eq('email', ADMIN_EMAIL);
  const { data: existing } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  for (const u of existing.users.filter((u) => u.email === ADMIN_EMAIL)) await admin.auth.admin.deleteUser(u.id);

  const { error: adminErr } = await admin.from('admins').insert({ email: ADMIN_EMAIL });
  if (adminErr) throw new Error('setup: admin insert failed: ' + adminErr.message);
  const { error: authErr } = await admin.auth.admin.createUser({ email: ADMIN_EMAIL, password: PASSWORD, email_confirm: true });
  if (authErr) throw new Error('setup: auth user create failed: ' + authErr.message);

  const user = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error: signInErr } = await user.auth.signInWithPassword({ email: ADMIN_EMAIL, password: PASSWORD });
  if (signInErr) throw new Error('setup: sign-in failed: ' + signInErr.message);
  return user;
}

async function cleanup() {
  await admin.from('admins').delete().eq('email', ADMIN_EMAIL);
  const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  for (const u of data.users.filter((u) => u.email === ADMIN_EMAIL)) await admin.auth.admin.deleteUser(u.id);
}

async function measureOnce(user, today) {
  const dayStartUtc = `${today}T00:00:00+05:30`;
  const dayEndUtc = new Date(new Date(dayStartUtc).getTime() + 24 * 60 * 60 * 1000).toISOString();

  const start = Date.now();
  await Promise.all([
    user.from('holidays').select('holiday_name').eq('date', today).maybeSingle(),
    user.from('employees').select('emp_id, name').eq('status', 'Active').order('name'),
    user.from('punch_logs').select('emp_id, punched_at, location_type').eq('action', 'IN').gte('punched_at', dayStartUtc).lt('punched_at', dayEndUtc),
    user.from('leave_requests').select('emp_id, status').in('status', ['Approved', 'Pending']).lte('leave_from', today).gte('leave_to', today),
  ]);
  return Date.now() - start;
}

async function main() {
  let user;
  try {
    user = await setup();
    const today = todayIST();

    console.log(`Running ${N} sequential dashboard-query rounds...`);
    const latencies = [];
    for (let i = 0; i < N; i++) {
      latencies.push(await measureOnce(user, today));
    }
    console.log(`Raw (ms), in call order: ${latencies.join(', ')}`);
    latencies.sort((a, b) => a - b);
    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    const max = latencies[latencies.length - 1];

    console.log(`\nLatency (ms): p50=${p50} p95=${p95} max=${max}`);
    const o1Pass = p95 < 400;
    console.log(`O1 (dashboard API p95 < 400ms): ${o1Pass ? 'PASS' : 'FAIL'} (p95=${p95}ms)`);
    process.exitCode = o1Pass ? 0 : 1;
  } finally {
    await cleanup();
  }
}

main().catch((e) => {
  console.error('Dashboard latency test crashed:', e);
  cleanup().finally(() => process.exit(1));
});
