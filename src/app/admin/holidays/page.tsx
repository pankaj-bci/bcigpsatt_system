import { createClient } from "@/lib/supabase/server";
import { AddHolidayForm } from "./add-holiday-form";
import { deleteHoliday } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminHolidaysPage() {
  const supabase = await createClient();
  const { data: holidays } = await supabase
    .from("holidays")
    .select("date, holiday_name")
    .order("date");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-zinc-900">Holidays</h2>
        <p className="text-sm text-zinc-500">
          Days marked here dispatch to &quot;Working Holiday&quot;/&quot;Holiday&quot; instead
          of the usual weekday rules.
        </p>
      </div>

      <div className="flex flex-col divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white">
        {(holidays ?? []).map((h) => (
          <div key={h.date} className="flex items-center justify-between px-4 py-3">
            <div>
              <p className="text-sm font-medium text-zinc-900">{h.holiday_name}</p>
              <p className="text-xs text-zinc-500">
                {new Date(`${h.date}T00:00:00`).toLocaleDateString("en-IN", {
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })}
              </p>
            </div>
            <form action={deleteHoliday}>
              <input type="hidden" name="date" value={h.date} />
              <button type="submit" className="text-sm text-red-600 hover:underline">
                Delete
              </button>
            </form>
          </div>
        ))}
        {(holidays ?? []).length === 0 && (
          <p className="px-4 py-3 text-sm text-zinc-500">No holidays yet.</p>
        )}
      </div>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-zinc-900">Add a holiday</h3>
        <AddHolidayForm />
      </div>
    </div>
  );
}
