import { createClient } from "@/lib/supabase/server";
import { AddEmployeeForm } from "./add-employee-form";

export const dynamic = "force-dynamic";

export default async function AdminAddEmployeePage() {
  const supabase = await createClient();
  const { data: locations } = await supabase
    .from("locations")
    .select("location_id, location_name")
    .order("location_id");

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold text-zinc-900">Add Employee</h2>
      <AddEmployeeForm locations={locations ?? []} />
    </div>
  );
}
