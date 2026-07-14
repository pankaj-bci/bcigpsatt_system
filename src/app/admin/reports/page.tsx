import { createClient } from "@/lib/supabase/server";
import { getISTNowParts } from "@/lib/date";
import { RegenerateAllButton } from "./regenerate-all-button";

export const dynamic = "force-dynamic";

const STAT_LABELS: { key: string; label: string }[] = [
  { key: "working_days", label: "Working Days" },
  { key: "total_present", label: "Present" },
  { key: "total_late", label: "Late" },
  { key: "total_early", label: "Early" },
  { key: "total_half_days", label: "Half Days" },
  { key: "total_absent", label: "Absent" },
  { key: "total_unpaid_absent", label: "Unpaid Absent" },
  { key: "total_working_sundays", label: "Working Sundays" },
  { key: "late_early_used", label: "Late/Early Used" },
  { key: "leave_credits_used", label: "Leave Credits Used" },
  { key: "total_leaves_used", label: "Total Leaves Used" },
];

export default async function AdminReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ emp_id?: string; month?: string }>;
}) {
  const params = await searchParams;
  const currentMonth = getISTNowParts().dateStr.slice(0, 7); // yyyy-MM
  const month = params.month || currentMonth;
  const empId = params.emp_id || "";

  const supabase = await createClient();
  const { data: employees } = await supabase.from("employees").select("emp_id, name").order("name");

  let summary: Record<string, unknown> | null = null;
  let summaryError: string | null = null;
  let extraDays: number | null = null;

  if (empId) {
    const { data, error } = await supabase.rpc("generate_monthly_summary", {
      p_emp_id: empId,
      p_month: `${month}-01`,
    });
    if (error) {
      summaryError = error.message;
    } else {
      summary = (Array.isArray(data) ? data[0] : data) ?? null;
    }

    const year = Number(month.slice(0, 4));
    const { data: extra } = await supabase.rpc("get_extra_days_yearly", { p_emp_id: empId, p_year: year });
    extraDays = extra !== null && extra !== undefined ? Number(extra) : null;
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-zinc-900">Reports</h2>
        <p className="text-sm text-zinc-500">
          Generates (and re-saves) the monthly rollup on demand, same as the old report screen.
        </p>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <form className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-zinc-500">Employee</span>
            <select
              name="emp_id"
              defaultValue={empId}
              className="h-10 rounded-lg border border-zinc-300 px-3 text-sm focus:border-blue-600 focus:outline-none"
            >
              <option value="">Select an employee…</option>
              {(employees ?? []).map((e) => (
                <option key={e.emp_id} value={e.emp_id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-zinc-500">Month</span>
            <input
              type="month"
              name="month"
              defaultValue={month}
              className="h-10 rounded-lg border border-zinc-300 px-3 text-sm focus:border-blue-600 focus:outline-none"
            />
          </label>
          <button
            type="submit"
            className="h-10 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700"
          >
            View report
          </button>
        </form>

        <RegenerateAllButton month={month} />
      </div>

      {!empId && <p className="text-sm text-zinc-500">Select an employee to view their monthly report.</p>}

      {summaryError && <p className="text-sm text-red-600">{summaryError}</p>}

      {summary && (
        <div>
          <h3 className="mb-3 text-sm font-semibold text-zinc-900">
            {employees?.find((e) => e.emp_id === empId)?.name ?? empId} — {month}
          </h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {STAT_LABELS.map((s) => (
              <div key={s.key} className="rounded-xl border border-zinc-200 bg-white p-4">
                <p className="text-2xl font-semibold text-zinc-900">
                  {String(summary[s.key] ?? "—")}
                </p>
                <p className="text-xs text-zinc-500">{s.label}</p>
              </div>
            ))}
            <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
              <p className="text-2xl font-semibold text-blue-700">{extraDays ?? "—"}</p>
              <p className="text-xs text-blue-700">Extra Days (year)</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
