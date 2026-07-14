"use client";

import { useActionState, useRef, useEffect } from "react";
import { addLocation } from "./actions";

const inputClass =
  "h-10 rounded-lg border border-zinc-300 px-3 text-sm focus:border-blue-600 focus:outline-none";

export function AddLocationForm() {
  const [state, formAction, pending] = useActionState(addLocation, undefined);
  const formRef = useRef<HTMLFormElement>(null);
  const prevPending = useRef(pending);

  useEffect(() => {
    if (prevPending.current && !pending && !state?.error) {
      formRef.current?.reset();
    }
    prevPending.current = pending;
  }, [pending, state]);

  return (
    <form
      ref={formRef}
      action={formAction}
      className="grid grid-cols-2 gap-3 rounded-xl border border-dashed border-zinc-300 p-4 sm:grid-cols-5 sm:items-end"
    >
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-zinc-500">ID (e.g. L2)</span>
        <input name="location_id" required className={inputClass} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-zinc-500">Name</span>
        <input name="location_name" required className={inputClass} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-zinc-500">Latitude</span>
        <input name="latitude" type="number" step="any" required className={inputClass} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-zinc-500">Longitude</span>
        <input name="longitude" type="number" step="any" required className={inputClass} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-zinc-500">Radius (m)</span>
        <input
          name="radius"
          type="number"
          step="1"
          min="1"
          defaultValue={100}
          required
          className={inputClass}
        />
      </label>
      <div className="col-span-2 flex items-center gap-3 sm:col-span-5">
        <button
          type="submit"
          disabled={pending}
          className="h-9 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {pending ? "Adding…" : "Add location"}
        </button>
        {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
      </div>
    </form>
  );
}
