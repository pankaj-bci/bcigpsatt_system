"use client";

import { useActionState, useEffect } from "react";
import { markLateAction } from "./mark-late/actions";
import type { TodayMember } from "./today-data";

const inputClass =
  "h-8 w-40 rounded-lg border border-zinc-300 px-2 text-xs focus:border-blue-600 focus:outline-none";

export function MarkLateRow({
  member,
  date,
  onDone,
}: {
  member: TodayMember;
  date: string;
  onDone: () => void;
}) {
  const [state, formAction, pending] = useActionState(markLateAction, undefined);

  useEffect(() => {
    if (state?.ok) onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
      <span className="text-sm font-medium text-zinc-900">{member.name}</span>
      {member.inTime && <span className="text-xs tabular-nums text-zinc-500">IN {member.inTime}</span>}
      {member.venue && <span className="text-xs text-zinc-500">{member.venue}</span>}
      {member.manualLate && (
        <span
          className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700"
          title={member.manualNote ?? undefined}
        >
          Late (admin){member.manualNote ? ` — ${member.manualNote}` : ""}
        </span>
      )}
      {member.isLate && !member.manualLate && (
        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-600">Late</span>
      )}

      {member.inTime && (
        <form action={formAction} className="flex items-center gap-2">
          <input type="hidden" name="emp_id" value={member.empId} />
          <input type="hidden" name="date" value={date} />
          {member.manualLate ? (
            <>
              <input type="hidden" name="late" value="false" />
              <button
                type="submit"
                disabled={pending}
                className="h-8 rounded-lg border border-zinc-300 px-2.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-50"
              >
                {pending ? "Removing…" : "Unmark"}
              </button>
            </>
          ) : (
            <>
              <input type="hidden" name="late" value="true" />
              <input name="note" placeholder="Note (optional)" className={inputClass} />
              <button
                type="submit"
                disabled={pending}
                className="h-8 rounded-lg bg-amber-500 px-2.5 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-50"
              >
                {pending ? "Marking…" : "Mark Late"}
              </button>
            </>
          )}
        </form>
      )}
      {state?.error && <span className="text-xs text-red-600">{state.error}</span>}
    </li>
  );
}
