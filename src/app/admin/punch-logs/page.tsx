import { createClient } from "@/lib/supabase/server";
import { getISTNowParts } from "@/lib/date";

export const dynamic = "force-dynamic";

type PunchRow = {
  log_id: number;
  action: "IN" | "OUT";
  punched_at: string;
  location_type: string | null;
  location_name: string | null;
  employees: { name: string } | { name: string }[] | null;
};

function employeeName(row: PunchRow): string {
  const e = row.employees;
  if (!e) return "—";
  return Array.isArray(e) ? (e[0]?.name ?? "—") : e.name;
}

export default async function AdminPunchLogsPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; emp_id?: string }>;
}) {
  const params = await searchParams;
  const today = getISTNowParts().dateStr;
  const date = params.date || today;
  const empId = params.emp_id || "";

  const supabase = await createClient();
  const [{ data: employees }, punchQuery] = await Promise.all([
    supabase.from("employees").select("emp_id, name").order("name"),
    (async () => {
      const dayStartUtc = `${date}T00:00:00+05:30`;
      const dayEndUtc = new Date(new Date(dayStartUtc).getTime() + 24 * 60 * 60 * 1000).toISOString();
      let query = supabase
        .from("punch_logs")
        .select("log_id, action, punched_at, location_type, location_name, employees(name)")
        .gte("punched_at", dayStartUtc)
        .lt("punched_at", dayEndUtc)
        .order("punched_at", { ascending: false });
      if (empId) query = query.eq("emp_id", empId);
      return query;
    })(),
  ]);

  const punches = (punchQuery.data ?? []) as unknown as PunchRow[];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold text-zinc-900">Punch Logs</h2>
        <p className="text-sm text-zinc-500">{punches.length} punch(es) on {date}</p>
      </div>

      <form className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-zinc-500">Date</span>
          <input
            type="date"
            name="date"
            defaultValue={date}
            className="h-10 rounded-lg border border-zinc-300 px-3 text-sm focus:border-blue-600 focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-zinc-500">Employee</span>
          <select
            name="emp_id"
            defaultValue={empId}
            className="h-10 rounded-lg border border-zinc-300 px-3 text-sm focus:border-blue-600 focus:outline-none"
          >
            <option value="">All employees</option>
            {(employees ?? []).map((e) => (
              <option key={e.emp_id} value={e.emp_id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="h-10 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700"
        >
          Filter
        </button>
      </form>

      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-100 text-left text-xs font-medium text-zinc-500">
              <th className="px-4 py-2">Time</th>
              <th className="px-4 py-2">Employee</th>
              <th className="px-4 py-2">Action</th>
              <th className="px-4 py-2">Location</th>
            </tr>
          </thead>
          <tbody>
            {punches.map((p) => (
              <tr key={p.log_id} className="border-b border-zinc-50 last:border-0">
                <td className="px-4 py-2 text-zinc-600">
                  {new Date(p.punched_at).toLocaleTimeString("en-IN", {
                    timeZone: "Asia/Kolkata",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </td>
                <td className="px-4 py-2 font-medium text-zinc-900">{employeeName(p)}</td>
                <td className="px-4 py-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      p.action === "IN" ? "bg-green-50 text-green-700" : "bg-zinc-100 text-zinc-600"
                    }`}
                  >
                    {p.action}
                  </span>
                </td>
                <td className="px-4 py-2 text-zinc-600">{p.location_name ?? p.location_type ?? "—"}</td>
              </tr>
            ))}
            {punches.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-zinc-500">
                  No punches for this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
