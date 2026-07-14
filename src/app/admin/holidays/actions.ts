"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { error?: string } | undefined;

export async function addHoliday(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const date = String(formData.get("date") ?? "");
  const holidayName = String(formData.get("holiday_name") ?? "").trim();

  if (!date || !holidayName) {
    return { error: "Date and name are required." };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("holidays").insert({ date, holiday_name: holidayName });

  if (error) {
    return {
      error: error.message.includes("duplicate")
        ? "A holiday is already set for that date."
        : error.message,
    };
  }

  revalidatePath("/admin/holidays");
}

export async function deleteHoliday(formData: FormData): Promise<void> {
  const date = String(formData.get("date") ?? "");
  if (!date) return;

  const supabase = await createClient();
  await supabase.from("holidays").delete().eq("date", date);

  revalidatePath("/admin/holidays");
}
