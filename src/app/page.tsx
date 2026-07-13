import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: isAdmin } = await supabase.rpc("is_admin");
  if (isAdmin) redirect("/admin");

  const { data: employee } = await supabase
    .from("employees")
    .select("status")
    .maybeSingle();

  if (employee?.status === "Active") redirect("/staff");

  redirect("/access-denied");
}
