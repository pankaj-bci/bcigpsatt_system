import { createClient } from "@/lib/supabase/server";
import { getISTNowParts } from "@/lib/date";
import { MonthPicker } from "./month-picker";

export const dynamic = "force-dynamic";

const STAT_LABELS: { key: string; label: string }[] = [
  { key: "working_days", label: "Working Days" },
  { key: "total_present", label: "Present" },
  { key: "total_late", label: "Late" },
  { key: "total_half_days", label: "Half Days" },
  { key: "total_absent", label: "Absent" },
  { key: "leave_credits_used", label: "Leave Credits Used" },
];

const statusColor: Record<string, string> = {
  Present: "bg-green-50 text-green-700",
  "Half Day": "bg-amber-50 text-amber-700",
  Absent: "bg-red-50 text-red-700",
  "Unpaid Absent": "bg-red-50 text-red-700",
  "Working Sunday": "bg-blue-50 text-blue-700",
  "Working Holiday": "bg-blue-50 text-blue-700",
  "Weekly Off": "bg-zinc-100 text-zinc-500",
  Holiday: "bg-zinc-100 text-zinc-500",
  "Punch In Only": "bg-purple-50 text-purple-700",
};

export default async function StaffDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const params = await searchParams;
  const currentMonth = getISTNowParts().dateStr.slice(0, 7);
  const month = params.month || currentMonth;

  const supabase = await createClient();
  const { data: employee } = await supabase.from("employees").select("emp_id").maybeSingle();

  if (!employee) {
    return <p className="mt-4 text-zinc-500">Your account isn&apos;t linked to an employee record.</p>;
  }

  // Same write-on-read pattern as the legacy Server_getMyDashboard: catch up
  // any missing past days, then refresh this month's rollup, before reading.
  await supabase.rpc("backfill_missing_days", { p_emp_id: employee.emp_id, p_month: `${month}-01` });
  const { data: summaryData } = await supabase.rpc("generate_monthly_summary", {
    p_emp_id: employee.emp_id,
    p_month: `${month}-01`,
  });
  const summary = (Array.isArray(summaryData) ? summaryData[0] : summaryData) as Record<
    string,
    unknown
  > | null;

  const monthStart = `${month}-01`;
  const monthEnd = new Date(new Date(`${monthStart}T00:00:00`).getFullYear(), new Date(`${monthStart}T00:00:00`).getMonth() + 1, 0)
    .toISOString()
    .slice(0, 10);

  const [{ data: daily }, { data: extra }] = await Promise.all([
    supabase
      .from("attendance_summary")
      .select("date, status, in_time, out_time, late_flag, early_flag, half_day_flag, notes, manual_late, manual_late_note")
      .eq("emp_id", employee.emp_id)
      .gte("date", monthStart)
      .lte("date", monthEnd)
      .order("date", { ascending: false }),
    supabase.rpc("get_extra_days_yearly", { p_emp_id: employee.emp_id, p_year: Number(month.slice(0, 4)) }),
  ]);

  return (
    <div className="flex flex-col gap-5 pt-2">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-zinc-900">My Dashboard</h2>
        <MonthPicker month={month} />
      </div>

      {summary && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {STAT_LABELS.map((s) => (
            <div key={s.key} className="rounded-xl border border-zinc-200 bg-white p-3">
              <p className="text-xl font-semibold text-zinc-900">{String(summary[s.key] ?? "—")}</p>
              <p className="text-xs text-zinc-500">{s.label}</p>
            </div>
          ))}
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-3">
            <p className="text-xl font-semibold text-blue-700">{extra !== null && extra !== undefined ? Number(extra) : "—"}</p>
            <p className="text-xs text-blue-700">Extra Days (year)</p>
          </div>
        </div>
      )}

      <div>
        <h3 className="mb-2 text-sm font-semibold text-zinc-900">Daily Attendance — {month}</h3>
        <div className="flex flex-col divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white">
          {(daily ?? []).map((d) => (
            <div key={d.date} className="flex items-center justify-between px-4 py-2.5">
              <div>
                <p className="text-sm font-medium text-zinc-900">
                  {new Date(`${d.date}T00:00:00`).toLocaleDateString("en-IN", {
                    weekday: "short",
                    day: "numeric",
                    month: "short",
                  })}
                </p>
                {(d.in_time || d.out_time) && (
                  <p className="text-xs text-zinc-500">
                    {d.in_time?.slice(0, 5) ?? "—"} → {d.out_time?.slice(0, 5) ?? "—"}
                  </p>
                )}
                {d.manual_late && (
                  <p className="mt-0.5 inline-block rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                    Marked late by admin{d.manual_late_note ? ` — ${d.manual_late_note}` : ""}
                  </p>
                )}
              </div>
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                  statusColor[d.status ?? ""] ?? "bg-zinc-100 text-zinc-600"
                }`}
              >
                {d.status}
              </span>
            </div>
          ))}
          {(daily ?? []).length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-zinc-500">No records for this month yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
