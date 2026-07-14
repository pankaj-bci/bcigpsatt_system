import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LogoutButton } from "@/app/logout-button";
import { AdminNav } from "@/app/admin/admin-nav";

export default async function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: isAdmin } = await supabase.rpc("is_admin");
  if (!isAdmin) redirect("/access-denied");

  return (
    <main className="flex min-h-full flex-1 flex-col bg-zinc-100 px-4 py-6">
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col">
        <header className="flex items-center justify-between pb-4">
          <div>
            <p className="text-xs font-bold tracking-wide text-blue-600">BCI</p>
            <h1 className="text-xl font-semibold text-zinc-900">GPS Attendance — Admin</h1>
            <p className="text-sm text-zinc-500">{user.email}</p>
          </div>
          <LogoutButton />
        </header>
        <AdminNav />
        <div className="mt-6 flex-1">{children}</div>
      </div>
    </main>
  );
}
