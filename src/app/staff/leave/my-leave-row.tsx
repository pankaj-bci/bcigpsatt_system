"use client";

import { useState } from "react";
import { getMyProofSignedUrl } from "./actions";

type Row = {
  request_id: string;
  leave_from: string;
  leave_to: string;
  request_type: string | null;
  reason: string | null;
  status: "Pending" | "Approved" | "Rejected";
  proof_path: string | null;
  admin_note: string | null;
};

const statusColor: Record<string, string> = {
  Pending: "bg-amber-50 text-amber-700",
  Approved: "bg-green-50 text-green-700",
  Rejected: "bg-red-50 text-red-700",
};

export function MyLeaveRow({ request }: { request: Row }) {
  const [loading, setLoading] = useState(false);

  async function viewProof() {
    if (!request.proof_path) return;
    setLoading(true);
    const url = await getMyProofSignedUrl(request.proof_path);
    setLoading(false);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-zinc-900">
            {request.leave_from} → {request.leave_to}
          </p>
          <p className="text-xs text-zinc-500">
            {request.request_type} · {request.reason}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${statusColor[request.status]}`}>
          {request.status}
        </span>
      </div>
      {request.admin_note && <p className="mt-1 text-xs text-zinc-500">Note: {request.admin_note}</p>}
      {request.proof_path && (
        <button
          type="button"
          onClick={viewProof}
          disabled={loading}
          className="mt-1 text-xs text-blue-600 hover:underline disabled:opacity-50"
        >
          {loading ? "Loading…" : "View my proof"}
        </button>
      )}
    </div>
  );
}
