"use client";

import { useActionState, useRef, useEffect } from "react";
import { addHoliday } from "./actions";

const inputClass =
  "h-10 rounded-lg border border-zinc-300 px-3 text-sm focus:border-blue-600 focus:outline-none";

export function AddHolidayForm() {
  const [state, formAction, pending] = useActionState(addHoliday, undefined);
  const formRef = useRef<HTMLFormElement>(null);
  const prevPending = useRef(pending);

  useEffect(() => {
    if (prevPending.current && !pending && !state?.error) {
      formRef.current?.reset();
    }
    prevPending.current = pending;
  }, [pending, state]);

  return (
    <form ref={formRef} action={formAction} className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-zinc-500">Date</span>
        <input name="date" type="date" required className={inputClass} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-zinc-500">Name</span>
        <input name="holiday_name" required placeholder="e.g. Diwali" className={inputClass} />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="h-10 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {pending ? "Adding…" : "Add holiday"}
      </button>
      {state?.error && <p className="w-full text-sm text-red-600">{state.error}</p>}
    </form>
  );
}
