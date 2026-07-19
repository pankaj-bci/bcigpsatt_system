"use server";

import { createClient } from "@/lib/supabase/server";
import { getISTNowParts } from "@/lib/date";

export type TodayMember = {
  empId: string;
  name: string;
  inTime: string | null; // IST "HH:MM" of first punch IN
  venue: string | null; // punch venue: location_name, "WFH", or "Other"
  isLate: boolean; // system late (after grace) OR admin-marked
  manualLate: boolean;
  manualNote: string | null;
};
export type TodayTile = { count: number; members: TodayMember[] };
export type TodayDashboard = {
  date: string;
  isOffDay: boolean;
  offReason: "Holiday" | "Sunday" | "";
  asOf: string;
  venueOptions: string[];
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

  const [
    { data: holiday },
    { data: employees },
    { data: todayIns },
    { data: leaves },
    { data: locations },
    { data: summaries },
  ] = await Promise.all([
    supabase.from("holidays").select("holiday_name").eq("date", today).maybeSingle(),
    supabase.from("employees").select("emp_id, name").eq("status", "Active").order("name"),
    supabase
      .from("punch_logs")
      .select("emp_id, punched_at, location_type, location_name")
      .eq("action", "IN")
      .gte("punched_at", dayStartUtc)
      .lt("punched_at", dayEndUtc),
    supabase
      .from("leave_requests")
      .select("emp_id, status")
      .in("status", ["Approved", "Pending"])
      .lte("leave_from", today)
      .gte("leave_to", today),
    supabase.from("locations").select("location_name").order("location_id"),
    supabase
      .from("attendance_summary")
      .select("emp_id, manual_late, manual_late_note")
      .eq("date", today),
  ]);

  const isHoliday = !!holiday;
  const isOffDay = isHoliday || isSunday;

  // Earliest IN per employee today.
  const firstInByEmp = new Map<
    string,
    { punched_at: string; location_type: string | null; location_name: string | null }
  >();
  for (const log of todayIns ?? []) {
    const existing = firstInByEmp.get(log.emp_id);
    if (!existing || log.punched_at < existing.punched_at) {
      firstInByEmp.set(log.emp_id, {
        punched_at: log.punched_at,
        location_type: log.location_type,
        location_name: log.location_name,
      });
    }
  }

  const onLeaveByEmp = new Map<string, string>();
  for (const lv of leaves ?? []) onLeaveByEmp.set(lv.emp_id, lv.status);

  const summaryByEmp = new Map(
    (summaries ?? []).map((s) => [s.emp_id, { manualLate: !!s.manual_late, note: s.manual_late_note }])
  );

  const emptyTile = (): TodayTile => ({ count: 0, members: [] });
  const tiles: TodayDashboard["tiles"] = {
    total_staff: emptyTile(),
    present: emptyTile(),
    absent: emptyTile(),
    late: emptyTile(),
    on_leave: emptyTile(),
    in_office: emptyTile(),
    in_workshop: emptyTile(),
    in_wfh: emptyTile(),
    in_other: emptyTile(),
    yet_to_punch: emptyTile(),
  };
  const add = (tile: keyof typeof tiles, member: TodayMember) => {
    tiles[tile].count++;
    tiles[tile].members.push(member);
  };

  for (const emp of employees ?? []) {
    const leaveStatus = onLeaveByEmp.get(emp.emp_id);
    const firstIn = firstInByEmp.get(emp.emp_id);
    const summary = summaryByEmp.get(emp.emp_id);

    const istMinutes = firstIn
      ? (() => {
          const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: "Asia/Kolkata",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
          }).formatToParts(new Date(firstIn.punched_at));
          const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
          const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
          return h * 60 + m;
        })()
      : null;

    const manualLate = summary?.manualLate ?? false;
    const member: TodayMember = {
      empId: emp.emp_id,
      name: emp.name,
      inTime:
        istMinutes !== null
          ? `${String(Math.floor(istMinutes / 60)).padStart(2, "0")}:${String(istMinutes % 60).padStart(2, "0")}`
          : null,
      venue: firstIn
        ? firstIn.location_type === "WFH"
          ? "WFH"
          : firstIn.location_type === "OTHER"
            ? "Other"
            : (firstIn.location_name ?? "Workshop")
        : null,
      isLate: (istMinutes !== null && istMinutes > GRACE_MIN) || manualLate,
      manualLate,
      manualNote: summary?.note ?? null,
    };

    add("total_staff", member);

    // Approved leave always wins. A Pending request only wins if the
    // employee hasn't actually punched in today -- a physical punch beats
    // an as-yet-undecided request.
    if (leaveStatus === "Approved" || (leaveStatus === "Pending" && !firstIn)) {
      add("on_leave", {
        ...member,
        name: emp.name + (leaveStatus === "Pending" ? " (Pending)" : ""),
      });
      continue;
    }

    if (firstIn) {
      add("present", member);

      if (member.isLate) add("late", member);

      switch (firstIn.location_type) {
        case "HEAD_OFFICE":
          add("in_office", member);
          break;
        case "WFH":
          add("in_wfh", member);
          break;
        case "OTHER":
          add("in_other", member);
          break;
        case "WORKSHOP":
        default:
          // record_punch() always sets location_type, so the null fallback
          // here is dead in practice -- kept only for defensive safety.
          add("in_workshop", member);
          break;
      }
    } else if (!isOffDay) {
      if (nowMin > GRACE_MIN) add("absent", member);
      else add("yet_to_punch", member);
    }
  }

  return {
    date: today,
    isOffDay,
    offReason: isHoliday ? "Holiday" : isSunday ? "Sunday" : "",
    asOf: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    venueOptions: [...(locations ?? []).map((l) => l.location_name), "WFH", "Other"],
    tiles,
  };
}
