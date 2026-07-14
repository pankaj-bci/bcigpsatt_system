"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { error?: string } | undefined;

export async function takeLeaveAction(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const requestId = String(formData.get("request_id") ?? "");
  const status = String(formData.get("status") ?? "");
  const adminNote = String(formData.get("admin_note") ?? "").trim() || null;

  if (!requestId || (status !== "Approved" && status !== "Rejected")) {
    return { error: "Invalid request." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_leave_action", {
    p_request_id: requestId,
    p_status: status,
    p_admin_note: adminNote,
  });

  if (error) return { error: error.message };

  revalidatePath("/admin/leave-requests");
}

export async function getProofSignedUrl(proofPath: string): Promise<string | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.storage
    .from("leave-proofs")
    .createSignedUrl(proofPath, 60);
  if (error) return null;
  return data.signedUrl;
}
