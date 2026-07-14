import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { EmployeeRow } from "./employee-row";

export const dynamic = "force-dynamic";

export default async function AdminEmployeesPage() {
  const supabase = await createClient();

  const [{ data: employees }, { data: locations }] = await Promise.all([
    supabase
      .from("employees")
      .select("emp_id, name, email, employee_type, assigned_location_id, status")
      .order("emp_id"),
    supabase.from("locations").select("location_id, location_name").order("location_id"),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900">Employees</h2>
          <p className="text-sm text-zinc-500">{employees?.length ?? 0} total</p>
        </div>
        <Link
          href="/admin/employees/add"
          className="h-9 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white leading-9 hover:bg-blue-700"
        >
          Add Employee
        </Link>
      </div>

      <div className="flex flex-col gap-2">
        {(employees ?? []).map((emp) => (
          <EmployeeRow key={emp.emp_id} employee={emp} locations={locations ?? []} />
        ))}
        {(employees ?? []).length === 0 && (
          <p className="text-sm text-zinc-500">No employees yet.</p>
        )}
      </div>
    </div>
  );
}
