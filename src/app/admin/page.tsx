import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LogoutButton } from "@/app/logout-button";

export default async function AdminPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: isAdmin } = await supabase.rpc("is_admin");
  if (!isAdmin) redirect("/access-denied");

  return (
    <main className="flex min-h-full flex-1 flex-col bg-zinc-50 px-4 py-8 dark:bg-black">
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
              GPS Attendance — Admin
            </h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">{user.email}</p>
          </div>
          <LogoutButton />
        </header>
        <p className="mt-8 text-zinc-500 dark:text-zinc-400">
          Admin dashboard placeholder — reports, employees, locations, and holidays land here in Phase 4.
        </p>
      </div>
    </main>
  );
}
