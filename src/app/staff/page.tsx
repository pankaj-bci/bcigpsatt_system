import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LogoutButton } from "@/app/logout-button";

export default async function StaffPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: employee } = await supabase
    .from("employees")
    .select("name, status")
    .maybeSingle();

  if (!employee || employee.status !== "Active") redirect("/access-denied");

  return (
    <main className="flex min-h-full flex-1 flex-col bg-zinc-950 px-4 py-8 text-zinc-50">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">GPS Attendance</h1>
            <p className="text-sm text-zinc-400">Welcome, {employee.name}</p>
          </div>
          <LogoutButton />
        </header>
        <p className="mt-8 text-zinc-400">
          Punch / dashboard / leave placeholder — built out in Phase 4.
        </p>
      </div>
    </main>
  );
}
