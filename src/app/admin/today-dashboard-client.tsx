"use client";

import { useEffect, useState, useTransition } from "react";
import { getTodayDashboard, type TodayDashboard } from "./today-data";
import { MarkLateRow } from "./mark-late-row";

const TILE_META: {
  key: keyof TodayDashboard["tiles"];
  label: string;
  sub: string;
  color: string;
}[] = [
  { key: "total_staff", label: "Total Staff", sub: "all active", color: "text-zinc-900" },
  { key: "present", label: "Present", sub: "punched in", color: "text-green-600" },
  { key: "yet_to_punch", label: "Yet to Punch", sub: "before grace", color: "text-zinc-500" },
  { key: "absent", label: "Absent", sub: "past grace, no punch", color: "text-red-600" },
  { key: "late", label: "Late", sub: "after 9:36 or marked", color: "text-amber-600" },
  { key: "on_leave", label: "On Leave", sub: "approved/pending", color: "text-purple-600" },
  { key: "in_office", label: "In Office", sub: "head office", color: "text-blue-600" },
  { key: "in_workshop", label: "In Workshop", sub: "workshop location", color: "text-blue-600" },
  { key: "in_wfh", label: "WFH", sub: "work from home", color: "text-blue-600" },
  { key: "in_other", label: "Other", sub: "field visit", color: "text-blue-600" },
];

export function TodayDashboardClient({ initialData }: { initialData: TodayDashboard }) {
  const [data, setData] = useState(initialData);
  const [expanded, setExpanded] = useState<keyof TodayDashboard["tiles"] | null>(null);
  const [venue, setVenue] = useState("All");
  const [isPending, startTransition] = useTransition();

  function refresh() {
    startTransition(async () => {
      const next = await getTodayDashboard();
      setData(next);
    });
  }

  useEffect(() => {
    const interval = setInterval(refresh, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900">
            Today&apos;s Live Status — {data.date}
          </h2>
          <p className="text-sm text-zinc-500">
            Live snapshot of punches, leave, and location. As of {data.asOf}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={venue}
            onChange={(e) => setVenue(e.target.value)}
            className="h-9 rounded-lg border border-zinc-300 px-2 text-sm text-zinc-700 focus:border-blue-600 focus:outline-none"
          >
            <option value="All">All venues</option>
            {data.venueOptions.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={refresh}
            disabled={isPending}
            className="h-9 rounded-lg border border-zinc-300 px-4 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            {isPending ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>
      <p className="text-xs text-zinc-400">Auto-refreshes every 5 min.</p>

      {data.isOffDay && (
        <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Today is a {data.offReason}. Staff are not marked absent today.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {TILE_META.map((tile) => {
          const t = data.tiles[tile.key];
          return (
            <button
              key={tile.key}
              type="button"
              onClick={() => setExpanded(expanded === tile.key ? null : tile.key)}
              className={`rounded-xl border p-4 text-left ${
                expanded === tile.key ? "border-blue-600 bg-blue-50" : "border-zinc-200 bg-white"
              }`}
            >
              <p className={`text-2xl font-semibold ${tile.color}`}>{t.count}</p>
              <p className="text-sm font-medium text-zinc-900">{tile.label}</p>
              <p className="text-xs text-zinc-500">{tile.sub}</p>
            </button>
          );
        })}
      </div>

      {expanded && (() => {
        const all = data.tiles[expanded].members;
        const shown = venue === "All" ? all : all.filter((m) => m.venue === venue);
        return (
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
            <p className="mb-2 text-sm font-semibold text-zinc-900">
              {TILE_META.find((t) => t.key === expanded)?.label} ({data.tiles[expanded].count})
              {venue !== "All" && (
                <span className="ml-2 font-normal text-zinc-500">
                  showing {shown.length} of {all.length} for {venue}
                </span>
              )}
            </p>
            {shown.length === 0 ? (
              <p className="text-sm text-zinc-500">
                {venue === "All" ? "Nobody in this bucket." : `Nobody in this bucket punched at ${venue}.`}
              </p>
            ) : (
              <ul className="divide-y divide-blue-100">
                {shown.map((member) => (
                  <MarkLateRow key={member.empId} member={member} date={data.date} onDone={refresh} />
                ))}
              </ul>
            )}
          </div>
        );
      })()}
    </div>
  );
}
