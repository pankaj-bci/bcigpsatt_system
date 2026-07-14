"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { error?: string } | undefined;

// Leave is informational only -- it never affects salary or attendance
// calculation. Ported from legacy Leave_submitRequest/frontend.html's
// leave form: LEAVE_APPROVERS ['AJ Mam','RJ Sir'], LEAVE_REASONS
// ['Vacation','Sick','Other'], LEAVE_TYPES ['Full Day','Half Day'].
//
// One deliberate deviation from the legacy shape: the old system let
// `proof_link` hold either a real Drive URL OR a free-text
// "Note: {description}" fallback when no screenshot was uploaded. Our
// `proof_path` is only ever a real Storage object path (or null) -- the
// admin "View proof" button (Task 18) generates a signed URL from it, which
// would break on a fake path. So the free-text approval description gets
// folded into `reason` instead, and `proof_path` stays null when there's no
// real upload.
export async function submitLeave(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const leaveFrom = String(formData.get("leave_from") ?? "");
  const leaveTo = String(formData.get("leave_to") ?? "");
  const requestType = String(formData.get("request_type") ?? "");
  const reasonChoice = String(formData.get("reason_choice") ?? "");
  const details = String(formData.get("details") ?? "").trim();
  const approvedBy = String(formData.get("approved_by") ?? "");
  const file = formData.get("proof_file") as File | null;

  if (!leaveFrom || !leaveTo || !requestType || !reasonChoice || !approvedBy) {
    return { error: "Please fill in every required field." };
  }

  const supabase = await createClient();
  const { data: employee } = await supabase.from("employees").select("emp_id").maybeSingle();
  if (!employee) {
    return { error: "Your account is not linked to an employee record." };
  }

  let proofPath: string | null = null;
  if (file && file.size > 0) {
    const path = `${employee.emp_id}/${Date.now()}-${file.name}`;
    const { error: uploadErr } = await supabase.storage.from("leave-proofs").upload(path, file);
    if (uploadErr) return { error: `Proof upload failed: ${uploadErr.message}` };
    proofPath = path;
  }

  const reason = details ? `${reasonChoice} — ${details}` : reasonChoice;

  const { error } = await supabase.rpc("submit_leave_request", {
    p_leave_from: leaveFrom,
    p_leave_to: leaveTo,
    p_request_type: requestType,
    p_reason: reason,
    p_approved_by: approvedBy,
    p_proof_path: proofPath,
  });

  if (error) return { error: error.message };

  revalidatePath("/staff/leave");
}

export async function getMyProofSignedUrl(proofPath: string): Promise<string | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.storage.from("leave-proofs").createSignedUrl(proofPath, 60);
  if (error) return null;
  return data.signedUrl;
}
