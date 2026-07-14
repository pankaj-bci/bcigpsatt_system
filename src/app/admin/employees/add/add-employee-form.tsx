"use client";

import { useActionState } from "react";
import Link from "next/link";
import { addEmployee } from "../actions";

type Location = { location_id: string; location_name: string };

const inputClass =
  "h-11 rounded-lg border border-zinc-300 px-3 text-sm focus:border-blue-600 focus:outline-none";
const labelClass = "text-sm font-medium text-zinc-700";

export function AddEmployeeForm({ locations }: { locations: Location[] }) {
  const [state, formAction, pending] = useActionState(addEmployee, undefined);

  return (
    <form action={formAction} className="flex max-w-md flex-col gap-4">
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Employee ID</span>
        <input name="emp_id" required placeholder="e.g. 0057" className={inputClass} />
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Name</span>
        <input name="name" required className={inputClass} />
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Email</span>
        <input name="email" type="email" required className={inputClass} />
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Type</span>
        <select name="employee_type" defaultValue="Fixed" className={inputClass}>
          <option value="Fixed">Fixed</option>
          <option value="Probation">Probation</option>
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Assigned location</span>
        <select name="assigned_location_id" defaultValue="" className={inputClass}>
          <option value="">— none —</option>
          {locations.map((loc) => (
            <option key={loc.location_id} value={loc.location_id}>
              {loc.location_name}
            </option>
          ))}
        </select>
      </label>
      {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="h-11 rounded-lg bg-blue-600 px-5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {pending ? "Adding…" : "Add employee"}
        </button>
        <Link href="/admin/employees" className="text-sm text-zinc-500 hover:text-zinc-700">
          Back to list
        </Link>
      </div>
    </form>
  );
}
