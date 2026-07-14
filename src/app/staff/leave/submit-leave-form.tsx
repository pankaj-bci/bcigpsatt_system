"use client";

import { useActionState, useRef, useEffect } from "react";
import { submitLeave } from "./actions";

const LEAVE_TYPES = ["Full Day", "Half Day"];
const LEAVE_REASONS = ["Vacation", "Sick", "Other"];
const LEAVE_APPROVERS = ["AJ Mam", "RJ Sir"];

const inputClass =
  "h-11 rounded-lg border border-zinc-300 px-3 text-sm focus:border-blue-600 focus:outline-none";
const labelClass = "text-sm font-medium text-zinc-700";

export function SubmitLeaveForm() {
  const [state, formAction, pending] = useActionState(submitLeave, undefined);
  const formRef = useRef<HTMLFormElement>(null);
  const prevPending = useRef(pending);

  useEffect(() => {
    if (prevPending.current && !pending && !state?.error) {
      formRef.current?.reset();
    }
    prevPending.current = pending;
  }, [pending, state]);

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Leave From *</span>
          <input name="leave_from" type="date" required className={inputClass} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Leave To *</span>
          <input name="leave_to" type="date" required className={inputClass} />
        </label>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Request Type *</span>
          <select name="request_type" required defaultValue="" className={inputClass}>
            <option value="" disabled>
              Select…
            </option>
            {LEAVE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Reason *</span>
          <select name="reason_choice" required defaultValue="" className={inputClass}>
            <option value="" disabled>
              Select…
            </option>
            {LEAVE_REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Approved By *</span>
        <select name="approved_by" required defaultValue="" className={inputClass}>
          <option value="" disabled>
            Select approver…
          </option>
          {LEAVE_APPROVERS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <span className="text-xs text-zinc-500">
          The person who approved your leave verbally or on WhatsApp.
        </span>
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Approval screenshot (optional)</span>
        <input name="proof_file" type="file" accept="image/*" className="text-sm" />
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Details (optional)</span>
        <textarea
          name="details"
          rows={2}
          placeholder="e.g. AJ Mam approved on WhatsApp on 14 Mar at 10:30 AM"
          className="rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-blue-600 focus:outline-none"
        />
      </label>
      {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="h-11 rounded-lg bg-blue-600 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {pending ? "Submitting…" : "Submit Leave Request"}
      </button>
    </form>
  );
}
