import { createClient } from "@/lib/supabase/server";
import { LogoutButton } from "@/app/logout-button";

export default async function AccessDeniedPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <main className="flex min-h-full flex-1 flex-col items-center justify-center bg-zinc-50 px-4 py-12 text-center dark:bg-black">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
        Access denied
      </h1>
      <p className="mt-2 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
        {user?.email ?? "This account"} isn't set up as staff or admin. Contact
        your administrator.
      </p>
      <div className="mt-6">
        <LogoutButton />
      </div>
    </main>
  );
}
