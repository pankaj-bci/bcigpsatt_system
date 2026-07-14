"use client";

import { useActionState } from "react";
import { regenerateAllForMonth } from "./actions";

export function RegenerateAllButton({ month }: { month: string }) {
  const [state, formAction, pending] = useActionState(regenerateAllForMonth, undefined);

  return (
    <form action={formAction} className="flex items-center gap-3">
      <input type="hidden" name="month" value={month} />
      <button
        type="submit"
        disabled={pending}
        className="h-9 rounded-lg border border-zinc-300 px-4 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
      >
        {pending ? "Regenerating…" : `Regenerate all for ${month}`}
      </button>
      {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
    </form>
  );
}
