import { createClient } from "@/lib/supabase/server";
import { SubmitLeaveForm } from "./submit-leave-form";
import { MyLeaveRow } from "./my-leave-row";

export const dynamic = "force-dynamic";

export default async function StaffLeavePage() {
  const supabase = await createClient();
  const { data: requests } = await supabase
    .from("leave_requests")
    .select("request_id, leave_from, leave_to, request_type, reason, status, proof_path, admin_note")
    .order("created_at", { ascending: false });

  return (
    <div className="flex flex-col gap-6 pt-2">
      <div>
        <h2 className="text-lg font-semibold text-zinc-900">Leave</h2>
        <p className="text-sm text-zinc-500">
          Informational only — doesn&apos;t affect salary or attendance calculation.
        </p>
      </div>

      <SubmitLeaveForm />

      <div>
        <h3 className="mb-2 text-sm font-semibold text-zinc-900">My Leave Requests</h3>
        <div className="flex flex-col gap-2">
          {(requests ?? []).map((r) => (
            <MyLeaveRow key={r.request_id} request={r} />
          ))}
          {(requests ?? []).length === 0 && (
            <p className="text-sm text-zinc-500">No leave requests yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
