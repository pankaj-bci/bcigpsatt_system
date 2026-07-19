"use client";

import { useActionState, useState } from "react";
import { resetDeviceAction, updateEmployee } from "./actions";

type Employee = {
  emp_id: string;
  name: string;
  email: string;
  employee_type: string;
  assigned_location_id: string | null;
  status: string;
};
type Location = { location_id: string; location_name: string };
type Device = {
  emp_id: string;
  bound_at: string;
  last_seen_at: string | null;
  user_agent: string | null;
  label: string | null;
} | null;

function formatDay(iso: string) {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

const inputClass =
  "h-9 rounded-lg border border-zinc-300 px-3 text-sm focus:border-blue-600 focus:outline-none";

export function EmployeeRow({
  employee,
  locations,
  device,
}: {
  employee: Employee;
  locations: Location[];
  device: Device;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(updateEmployee, undefined);
  const [resetState, resetAction, resetPending] = useActionState(resetDeviceAction, undefined);

  return (
    <div className="rounded-xl border border-zinc-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 p-3 text-left"
      >
        <div className="flex min-w-0 items-center gap-3">
          <span className="shrink-0 text-xs font-mono text-zinc-400">{employee.emp_id}</span>
          <span className="truncate text-sm font-medium text-zinc-900">{employee.name}</span>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
              employee.status === "Active" ? "bg-green-50 text-green-700" : "bg-zinc-100 text-zinc-500"
            }`}
          >
            {employee.status}
          </span>
          <span className="shrink-0 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-600">
            {employee.employee_type}
          </span>
        </div>
        <span className="shrink-0 text-xs text-zinc-400">{open ? "Close" : "Edit"}</span>
      </button>

      {open && (
        <form action={formAction} className="grid grid-cols-2 gap-3 border-t border-zinc-100 p-4">
          <input type="hidden" name="emp_id" value={employee.emp_id} />
          <label className="col-span-2 flex flex-col gap-1 sm:col-span-1">
            <span className="text-xs font-medium text-zinc-500">Name</span>
            <input name="name" defaultValue={employee.name} required className={inputClass} />
          </label>
          <label className="col-span-2 flex flex-col gap-1 sm:col-span-1">
            <span className="text-xs font-medium text-zinc-500">Email</span>
            <input
              name="email"
              type="email"
              defaultValue={employee.email}
              required
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-zinc-500">Type</span>
            <select name="employee_type" defaultValue={employee.employee_type} className={inputClass}>
              <option value="Fixed">Fixed</option>
              <option value="Probation">Probation</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-zinc-500">Status</span>
            <select name="status" defaultValue={employee.status} className={inputClass}>
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-zinc-500">Assigned location</span>
            <select
              name="assigned_location_id"
              defaultValue={employee.assigned_location_id ?? ""}
              className={inputClass}
            >
              <option value="">— none —</option>
              {locations.map((loc) => (
                <option key={loc.location_id} value={loc.location_id}>
                  {loc.location_name}
                </option>
              ))}
            </select>
          </label>
          <div className="col-span-2 flex items-center gap-3">
            <button
              type="submit"
              disabled={pending}
              className="h-9 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {pending ? "Saving…" : "Save"}
            </button>
            {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
          </div>
        </form>
      )}

      {open && (
        <div className="flex flex-wrap items-center gap-3 border-t border-zinc-100 p-4">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-zinc-500">Registered device</p>
            {device ? (
              <p className="truncate text-sm text-zinc-700">
                Bound {formatDay(device.bound_at)}
                {device.last_seen_at && ` · last punch ${formatDay(device.last_seen_at)}`}
                {(device.label || device.user_agent) &&
                  ` · ${device.label ?? device.user_agent?.slice(0, 60)}`}
              </p>
            ) : (
              <p className="text-sm text-zinc-500">No device bound — binds on first punch.</p>
            )}
          </div>
          {device && (
            <form
              action={resetAction}
              onSubmit={(e) => {
                if (
                  !confirm(
                    `Reset ${employee.name}'s device? Their next punch (from any phone) becomes the new registered device.`
                  )
                ) {
                  e.preventDefault();
                }
              }}
            >
              <input type="hidden" name="emp_id" value={employee.emp_id} />
              <button
                type="submit"
                disabled={resetPending}
                className="h-9 rounded-lg border border-red-200 px-4 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                {resetPending ? "Resetting…" : "Reset device"}
              </button>
            </form>
          )}
          {resetState?.error && <p className="text-sm text-red-600">{resetState.error}</p>}
        </div>
      )}
    </div>
  );
}
