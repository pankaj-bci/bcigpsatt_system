"use client";

import { useActionState, useState } from "react";
import { takeLeaveAction, getProofSignedUrl } from "./actions";

type LeaveRequest = {
  request_id: string;
  emp_id: string;
  name: string | null;
  leave_from: string;
  leave_to: string;
  request_type: string | null;
  reason: string | null;
  approved_by: string | null;
  proof_path: string | null;
  status: "Pending" | "Approved" | "Rejected";
  created_at: string;
  admin_note: string | null;
};

const statusColor: Record<string, string> = {
  Pending: "bg-amber-50 text-amber-700",
  Approved: "bg-green-50 text-green-700",
  Rejected: "bg-red-50 text-red-700",
};

export function LeaveRow({ request }: { request: LeaveRequest }) {
  const [state, formAction, pending] = useActionState(takeLeaveAction, undefined);
  const [proofUrl, setProofUrl] = useState<string | null>(null);
  const [proofLoading, setProofLoading] = useState(false);

  async function viewProof() {
    if (!request.proof_path) return;
    setProofLoading(true);
    const url = await getProofSignedUrl(request.proof_path);
    setProofLoading(false);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-zinc-900">
            {request.name ?? request.emp_id}{" "}
            <span className="font-mono text-xs text-zinc-400">{request.emp_id}</span>
          </p>
          <p className="text-sm text-zinc-600">
            {request.leave_from} → {request.leave_to} · {request.request_type ?? "—"}
          </p>
          {request.reason && <p className="mt-1 text-sm text-zinc-500">{request.reason}</p>}
          {request.approved_by && (
            <p className="mt-1 text-xs text-zinc-400">Approved by (per request): {request.approved_by}</p>
          )}
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${statusColor[request.status]}`}>
          {request.status}
        </span>
      </div>

      {request.proof_path && (
        <button
          type="button"
          onClick={viewProof}
          disabled={proofLoading}
          className="mt-2 text-sm text-blue-600 hover:underline disabled:opacity-50"
        >
          {proofLoading ? "Loading…" : "View proof"}
        </button>
      )}

      {request.status === "Pending" ? (
        <form action={formAction} className="mt-3 flex flex-wrap items-center gap-2">
          <input type="hidden" name="request_id" value={request.request_id} />
          <input
            name="admin_note"
            placeholder="Note (optional)"
            className="h-9 flex-1 min-w-[10rem] rounded-lg border border-zinc-300 px-3 text-sm focus:border-blue-600 focus:outline-none"
          />
          <button
            type="submit"
            name="status"
            value="Approved"
            disabled={pending}
            className="h-9 rounded-lg bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Approve
          </button>
          <button
            type="submit"
            name="status"
            value="Rejected"
            disabled={pending}
            className="h-9 rounded-lg border border-red-300 px-3 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            Reject
          </button>
          {state?.error && <p className="w-full text-sm text-red-600">{state.error}</p>}
        </form>
      ) : (
        request.admin_note && <p className="mt-2 text-sm text-zinc-500">Note: {request.admin_note}</p>
      )}
    </div>
  );
}
