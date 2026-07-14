"use client";

import { useActionState, useState } from "react";
import { signupStaff, signupAdmin } from "@/app/actions/auth";

type Employee = { emp_id: string; name: string };

const inputClass =
  "h-12 rounded-lg border border-zinc-300 px-4 text-base focus:border-blue-600 focus:outline-none";
const labelClass = "text-sm font-medium text-zinc-700";

export function SignupForm({ employees }: { employees: Employee[] }) {
  const [mode, setMode] = useState<"staff" | "admin">("staff");
  const [staffState, staffAction, staffPending] = useActionState(signupStaff, undefined);
  const [adminState, adminAction, adminPending] = useActionState(signupAdmin, undefined);

  return (
    <div className="mt-6">
      <div className="mb-4 flex rounded-lg bg-zinc-100 p-1 text-sm font-medium">
        <button
          type="button"
          onClick={() => setMode("staff")}
          className={`flex-1 rounded-md py-2 ${
            mode === "staff" ? "bg-white text-blue-600 shadow-sm" : "text-zinc-500"
          }`}
        >
          I&apos;m staff
        </button>
        <button
          type="button"
          onClick={() => setMode("admin")}
          className={`flex-1 rounded-md py-2 ${
            mode === "admin" ? "bg-white text-blue-600 shadow-sm" : "text-zinc-500"
          }`}
        >
          I&apos;m an admin
        </button>
      </div>

      {mode === "staff" ? (
        <form action={staffAction} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="emp_id" className={labelClass}>
              Your name
            </label>
            <select id="emp_id" name="emp_id" required className={inputClass}>
              <option value="">Select your name…</option>
              {employees.map((e) => (
                <option key={e.emp_id} value={e.emp_id}>
                  {e.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="email" className={labelClass}>
              Email on file for you
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              className={inputClass}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="password" className={labelClass}>
              Create a password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              className={inputClass}
            />
          </div>
          {staffState?.error && <p className="text-sm text-red-600">{staffState.error}</p>}
          <button
            type="submit"
            disabled={staffPending}
            className="h-12 rounded-lg bg-blue-600 text-base font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {staffPending ? "Creating account…" : "Create account"}
          </button>
        </form>
      ) : (
        <form action={adminAction} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="admin_email" className={labelClass}>
              Admin email
            </label>
            <input
              id="admin_email"
              name="email"
              type="email"
              autoComplete="email"
              required
              className={inputClass}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="admin_password" className={labelClass}>
              Create a password
            </label>
            <input
              id="admin_password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              className={inputClass}
            />
          </div>
          {adminState?.error && <p className="text-sm text-red-600">{adminState.error}</p>}
          <button
            type="submit"
            disabled={adminPending}
            className="h-12 rounded-lg bg-blue-600 text-base font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {adminPending ? "Creating account…" : "Create account"}
          </button>
        </form>
      )}
    </div>
  );
}
