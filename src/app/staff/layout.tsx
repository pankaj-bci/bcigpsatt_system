import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LogoutButton } from "@/app/logout-button";
import { StaffNav } from "@/app/staff/staff-nav";

export default async function StaffLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
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
    <div className="flex min-h-full flex-1 flex-col bg-zinc-100 text-zinc-900">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-zinc-100 px-4 pt-6 pb-3">
          <div>
            <p className="text-xs font-bold tracking-wide text-blue-600">BCI</p>
            <p className="text-sm font-semibold">📍 GPS Attendance</p>
            <p className="text-xs text-zinc-500">Location-verified punch system</p>
          </div>
          <LogoutButton className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600" />
        </header>
        <div className="flex-1 px-4 pb-4">{children}</div>
        <StaffNav />
      </div>
    </div>
  );
}
