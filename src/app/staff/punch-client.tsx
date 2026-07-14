"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Location = { location_id: string; location_name: string };
type LastPunch = { action: "IN" | "OUT"; punched_at: string } | null;

const SPECIAL_TILES = [
  { location_id: "WFH", location_name: "Work From Home", icon: "🏠", note: "Valid if >5 km from office" },
  { location_id: "OTHER", location_name: "Other / Field Visit", icon: "🌍", note: "Valid if >2 km from office" },
];

function formatClock(d: Date) {
  return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDate(d: Date) {
  return d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

export function PunchClient({
  employeeName,
  employeeType,
  employeeEmail,
  locations,
  initialLastPunch,
}: {
  employeeName: string;
  employeeType: string;
  employeeEmail: string;
  locations: Location[];
  initialLastPunch: LastPunch;
}) {
  const [now, setNow] = useState<Date | null>(null);
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const [position, setPosition] = useState<GeolocationPosition | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [lastPunch, setLastPunch] = useState(initialLastPunch);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [pendingAction, setPendingAction] = useState<"IN" | "OUT" | null>(null);

  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!("geolocation" in navigator)) {
      setGeoError("This device doesn't support location.");
      return;
    }
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setPosition(pos);
        setGeoError(null);
      },
      (err) => setGeoError(err.message || "Couldn't get your location."),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  const accuracy = position?.coords.accuracy ?? null;
  const accuracyValid = accuracy !== null && accuracy > 0 && accuracy <= 100;
  const canPunch = selectedLocationId !== null && position !== null && accuracyValid && pendingAction === null;

  async function handlePunch(action: "IN" | "OUT") {
    if (!position || !selectedLocationId) return;
    setPendingAction(action);
    setMessage(null);

    const supabase = createClient();
    const { data, error } = await supabase.rpc("record_punch", {
      p_action: action,
      p_location_id: selectedLocationId,
      p_lat: position.coords.latitude,
      p_lon: position.coords.longitude,
      p_accuracy: position.coords.accuracy,
    });

    setPendingAction(null);

    if (error) {
      setMessage({ text: error.message, ok: false });
      return;
    }
    const result = Array.isArray(data) ? data[0] : data;
    setMessage({ text: result?.message ?? "Something went wrong.", ok: !!result?.success });
    if (result?.success) {
      setLastPunch({ action, punched_at: new Date().toISOString() });
    }
  }

  return (
    <div className="flex flex-col gap-5 pt-2">
      {now && (
        <div className="text-center">
          <p className="text-3xl font-semibold tabular-nums text-zinc-900">{formatClock(now)}</p>
          <p className="text-sm text-zinc-500">{formatDate(now)}</p>
        </div>
      )}

      <div className="rounded-xl border border-zinc-200 bg-white p-4">
        <p className="text-sm text-zinc-500">Welcome,</p>
        <p className="text-lg font-semibold text-zinc-900">{employeeName}</p>
        <p className="text-sm text-zinc-500">{employeeEmail}</p>
        <span className="mt-2 inline-block rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-600">
          {employeeType}
        </span>
      </div>

      <div className="rounded-xl bg-blue-50 p-3 text-sm text-blue-900">
        Select your current location below, then punch IN or OUT.
      </div>

      <div>
        <p className="mb-2 text-sm font-semibold text-zinc-900">SELECT YOUR CURRENT LOCATION *</p>
        <div className="grid grid-cols-2 gap-3">
          {locations.map((loc) => (
            <button
              key={loc.location_id}
              type="button"
              onClick={() => setSelectedLocationId(loc.location_id)}
              className={`rounded-xl border p-3 text-left text-sm font-medium ${
                selectedLocationId === loc.location_id
                  ? "border-blue-600 bg-blue-50 text-blue-700"
                  : "border-zinc-200 bg-white text-zinc-700"
              }`}
            >
              {loc.location_name}
            </button>
          ))}
          {SPECIAL_TILES.map((tile) => (
            <button
              key={tile.location_id}
              type="button"
              onClick={() => setSelectedLocationId(tile.location_id)}
              className={`rounded-xl border p-3 text-left text-sm font-medium ${
                selectedLocationId === tile.location_id
                  ? "border-blue-600 bg-blue-50 text-blue-700"
                  : "border-zinc-200 bg-white text-zinc-700"
              }`}
            >
              <span>
                {tile.icon} {tile.location_name}
              </span>
              <span className="mt-0.5 block text-xs font-normal text-zinc-500">{tile.note}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 text-sm">
        <span
          className={`h-2.5 w-2.5 rounded-full ${
            geoError ? "bg-red-500" : accuracyValid ? "bg-green-500" : accuracy !== null ? "bg-amber-500" : "bg-zinc-300"
          }`}
        />
        {geoError ? (
          <span className="text-red-600">{geoError}</span>
        ) : accuracy !== null ? (
          <span className={accuracyValid ? "text-green-700" : "text-amber-700"}>
            GPS {accuracyValid ? "ready" : "weak"} — {Math.round(accuracy)}m accuracy
          </span>
        ) : (
          <span className="text-zinc-500">Waiting for GPS…</span>
        )}
      </div>

      <p className="text-sm text-zinc-500">
        {lastPunch
          ? `Last punch: ${lastPunch.action} at ${new Date(lastPunch.punched_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`
          : "No punch recorded yet."}
      </p>

      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          disabled={!canPunch}
          onClick={() => handlePunch("IN")}
          className="h-14 rounded-xl bg-blue-600 text-base font-semibold text-white disabled:opacity-40"
        >
          {pendingAction === "IN" ? "Punching IN…" : "PUNCH IN"}
        </button>
        <button
          type="button"
          disabled={!canPunch}
          onClick={() => handlePunch("OUT")}
          className="h-14 rounded-xl border-2 border-blue-600 text-base font-semibold text-blue-600 disabled:opacity-40"
        >
          {pendingAction === "OUT" ? "Punching OUT…" : "PUNCH OUT"}
        </button>
      </div>

      {message && (
        <p className={`text-sm ${message.ok ? "text-green-700" : "text-red-600"}`}>{message.text}</p>
      )}
    </div>
  );
}
