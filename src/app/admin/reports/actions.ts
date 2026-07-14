"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { error?: string } | undefined;

export async function regenerateAllForMonth(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const month = String(formData.get("month") ?? "");
  if (!month) return { error: "Pick a month first." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("generate_monthly_summary_all", {
    p_month: `${month}-01`,
  });

  if (error) return { error: error.message };

  revalidatePath("/admin/reports");
}
