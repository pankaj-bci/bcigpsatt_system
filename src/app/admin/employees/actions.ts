"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { error?: string } | undefined;

export async function addEmployee(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const empId = String(formData.get("emp_id") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const employeeType = String(formData.get("employee_type") ?? "Fixed");
  const assignedLocationId = String(formData.get("assigned_location_id") ?? "") || null;

  if (!empId || !name || !email) {
    return { error: "Employee ID, name, and email are required." };
  }

  const supabase = await createClient();
  // shift_start_time is intentionally left to its column default (09:30) --
  // decision 6.4: all employees use the global shift for now, per-employee
  // shift times aren't honoured by evaluate_fixed() yet.
  const { error } = await supabase.from("employees").insert({
    emp_id: empId,
    name,
    email,
    employee_type: employeeType,
    assigned_location_id: assignedLocationId,
    status: "Active",
  });

  if (error) {
    return {
      error: error.message.includes("duplicate")
        ? "That employee ID or email already exists."
        : error.message,
    };
  }

  revalidatePath("/admin/employees");
  redirect("/admin/employees");
}

export async function updateEmployee(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const empId = String(formData.get("emp_id") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const employeeType = String(formData.get("employee_type") ?? "Fixed");
  const assignedLocationId = String(formData.get("assigned_location_id") ?? "") || null;
  const status = String(formData.get("status") ?? "Active");

  if (!empId || !name || !email) {
    return { error: "Name and email are required." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("employees")
    .update({
      name,
      email,
      employee_type: employeeType,
      assigned_location_id: assignedLocationId,
      status,
    })
    .eq("emp_id", empId);

  if (error) return { error: error.message };

  revalidatePath("/admin/employees");
}

// Unbinds the employee's registered phone. Their next punch (from any phone)
// auto-binds that device as the new one — see record_punch() device block.
export async function resetDeviceAction(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const empId = String(formData.get("emp_id") ?? "").trim();
  if (!empId) return { error: "Missing employee ID." };

  const supabase = await createClient();
  const { error } = await supabase.from("employee_devices").delete().eq("emp_id", empId);

  if (error) return { error: error.message };

  revalidatePath("/admin/employees");
}
