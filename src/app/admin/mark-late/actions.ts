"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type MarkLateState = { error?: string; ok?: boolean } | undefined;

export async function markLateAction(
  _prevState: MarkLateState,
  formData: FormData
): Promise<MarkLateState> {
  const empId = String(formData.get("emp_id") ?? "").trim();
  const date = String(formData.get("date") ?? "").trim();
  const late = String(formData.get("late") ?? "") === "true";
  const note = String(formData.get("note") ?? "").trim() || null;

  if (!empId || !date) return { error: "Invalid request." };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_mark_late", {
    p_emp_id: empId,
    p_date: date,
    p_late: late,
    p_note: note,
  });

  if (error) return { error: error.message };

  // The RPC reports business-rule failures (no punch IN, Sunday, holiday)
  // as rows, not as Postgres errors -- same shape as record_punch.
  const result = Array.isArray(data) ? data[0] : data;
  if (!result?.success) return { error: result?.message ?? "Something went wrong." };

  revalidatePath("/admin");
  return { ok: true };
}
