import { createClient } from "@/lib/supabase/server";
import { LeaveRow } from "./leave-row";

export const dynamic = "force-dynamic";

const STATUSES = ["Pending", "Approved", "Rejected", "All"] as const;

export default async function AdminLeaveRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const params = await searchParams;
  const status = params.status && (STATUSES as readonly string[]).includes(params.status)
    ? params.status
    : "Pending";

  const supabase = await createClient();
  let query = supabase
    .from("leave_requests")
    .select(
      "request_id, emp_id, name, leave_from, leave_to, request_type, reason, approved_by, proof_path, status, created_at, admin_note"
    )
    .order("created_at", { ascending: false });
  if (status !== "All") query = query.eq("status", status);
  const { data: requests } = await query;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold text-zinc-900">Leave Requests</h2>
        <p className="text-sm text-zinc-500">
          Informational only — leave requests never affect salary or attendance calculation.
        </p>
      </div>

      <div className="flex gap-1">
        {STATUSES.map((s) => (
          <a
            key={s}
            href={`/admin/leave-requests?status=${s}`}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${
              status === s ? "bg-blue-600 text-white" : "text-zinc-600 hover:bg-zinc-100"
            }`}
          >
            {s}
          </a>
        ))}
      </div>

      <div className="flex flex-col gap-3">
        {(requests ?? []).map((r) => (
          <LeaveRow key={r.request_id} request={r} />
        ))}
        {(requests ?? []).length === 0 && (
          <p className="text-sm text-zinc-500">No {status.toLowerCase()} leave requests.</p>
        )}
      </div>
    </div>
  );
}
