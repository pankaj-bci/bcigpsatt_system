import { createClient } from "@/lib/supabase/server";
import { PunchClient } from "./punch-client";

export const dynamic = "force-dynamic";

export default async function StaffPunchPage() {
  const supabase = await createClient();

  const [{ data: employee }, { data: locations }, { data: punches }] = await Promise.all([
    supabase.from("employees").select("name, email, employee_type").maybeSingle(),
    supabase.from("locations").select("location_id, location_name").order("location_id"),
    supabase
      .from("punch_logs")
      .select("action, punched_at")
      .order("punched_at", { ascending: false })
      .limit(1),
  ]);

  return (
    <PunchClient
      employeeName={employee?.name ?? ""}
      employeeEmail={employee?.email ?? ""}
      employeeType={employee?.employee_type ?? ""}
      locations={locations ?? []}
      initialLastPunch={punches?.[0] ?? null}
    />
  );
}
