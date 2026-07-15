"use server";

import { createClient } from "@/lib/supabase/server";
import { getISTNowParts } from "@/lib/date";

export type TodayTile = { count: number; names: string[] };
export type TodayDashboard = {
  date: string;
  isOffDay: boolean;
  offReason: "Holiday" | "Sunday" | "";
  asOf: string;
  tiles: {
    total_staff: TodayTile;
    present: TodayTile;
    absent: TodayTile;
    late: TodayTile;
    on_leave: TodayTile;
    in_office: TodayTile;
    in_workshop: TodayTile;
    in_wfh: TodayTile;
    in_other: TodayTile;
    yet_to_punch: TodayTile;
  };
};

const GRACE_MIN = 9 * 60 + 36; // shift start (09:30) + 6 min, matches evaluate_fixed's on-time cutoff

export async function getTodayDashboard(): Promise<TodayDashboard> {
  const supabase = await createClient();
  const { dateStr: today, hour, minute, weekday } = getISTNowParts();
  const nowMin = hour * 60 + minute;
  const isSunday = weekday === 0;

  const dayStartUtc = `${today}T00:00:00+05:30`;
  const dayEndUtc = new Date(new Date(dayStartUtc).getTime() + 24 * 60 * 60 * 1000).toISOString();

  const [{ data: holiday }, { data: employees }, { data: todayIns }, { data: leaves }] =
    await Promise.all([
      supabase.from("holidays").select("holiday_name").eq("date", today).maybeSingle(),
      supabase.from("employees").select("emp_id, name").eq("status", "Active").order("name"),
      supabase
        .from("punch_logs")
        .select("emp_id, punched_at, location_type")
        .eq("action", "IN")
        .gte("punched_at", dayStartUtc)
        .lt("punched_at", dayEndUtc),
      supabase
        .from("leave_requests")
        .select("emp_id, status")
        .in("status", ["Approved", "Pending"])
        .lte("leave_from", today)
        .gte("leave_to", today),
    ]);

  const isHoliday = !!holiday;
  const isOffDay = isHoliday || isSunday;

  // Earliest IN per employee today.
  const firstInByEmp = new Map<string, { punched_at: string; location_type: string | null }>();
  for (const log of todayIns ?? []) {
    const existing = firstInByEmp.get(log.emp_id);
    if (!existing || log.punched_at < existing.punched_at) {
      firstInByEmp.set(log.emp_id, { punched_at: log.punched_at, location_type: log.location_type });
    }
  }

  const onLeaveByEmp = new Map<string, string>();
  for (const lv of leaves ?? []) onLeaveByEmp.set(lv.emp_id, lv.status);

  const tiles: TodayDashboard["tiles"] = {
    total_staff: { count: 0, names: [] },
    present: { count: 0, names: [] },
    absent: { count: 0, names: [] },
    late: { count: 0, names: [] },
    on_leave: { count: 0, names: [] },
    in_office: { count: 0, names: [] },
    in_workshop: { count: 0, names: [] },
    in_wfh: { count: 0, names: [] },
    in_other: { count: 0, names: [] },
    yet_to_punch: { count: 0, names: [] },
  };
  const add = (tile: keyof typeof tiles, name: string) => {
    tiles[tile].count++;
    tiles[tile].names.push(name);
  };

  for (const emp of employees ?? []) {
    add("total_staff", emp.name);

    const leaveStatus = onLeaveByEmp.get(emp.emp_id);
    const firstIn = firstInByEmp.get(emp.emp_id);

    // Approved leave always wins. A Pending request only wins if the
    // employee hasn't actually punched in today -- a physical punch beats
    // an as-yet-undecided request.
    if (leaveStatus === "Approved" || (leaveStatus === "Pending" && !firstIn)) {
      add("on_leave", emp.name + (leaveStatus === "Pending" ? " (Pending)" : ""));
      continue;
    }

    if (firstIn) {
      add("present", emp.name);

      const istMinutes = (() => {
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone: "Asia/Kolkata",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).formatToParts(new Date(firstIn.punched_at));
        const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
        const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
        return h * 60 + m;
      })();
      if (istMinutes > GRACE_MIN) add("late", emp.name);

      switch (firstIn.location_type) {
        case "HEAD_OFFICE":
          add("in_office", emp.name);
          break;
        case "WFH":
          add("in_wfh", emp.name);
          break;
        case "OTHER":
          add("in_other", emp.name);
          break;
        case "WORKSHOP":
        default:
          // record_punch() always sets location_type, so the null fallback
          // here is dead in practice -- kept only for defensive safety.
          add("in_workshop", emp.name);
          break;
      }
    } else if (!isOffDay) {
      if (nowMin > GRACE_MIN) add("absent", emp.name);
      else add("yet_to_punch", emp.name);
    }
  }

  return {
    date: today,
    isOffDay,
    offReason: isHoliday ? "Holiday" : isSunday ? "Sunday" : "",
    asOf: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    tiles,
  };
}
