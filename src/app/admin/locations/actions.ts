"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type ActionState = { error?: string } | undefined;

function parseCoord(raw: FormDataEntryValue | null, label: string): number | { error: string } {
  const n = Number(raw);
  if (raw === null || raw === "" || Number.isNaN(n)) {
    return { error: `${label} must be a number.` };
  }
  return n;
}

export async function addLocation(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const locationId = String(formData.get("location_id") ?? "").trim();
  const locationName = String(formData.get("location_name") ?? "").trim();
  const latitude = parseCoord(formData.get("latitude"), "Latitude");
  const longitude = parseCoord(formData.get("longitude"), "Longitude");
  const radius = Number(formData.get("radius") ?? 100);

  if (!locationId || !locationName) {
    return { error: "Location ID and name are required." };
  }
  if (typeof latitude !== "number") return latitude;
  if (typeof longitude !== "number") return longitude;
  if (!Number.isFinite(radius) || radius <= 0) {
    return { error: "Radius must be a positive number of metres." };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("locations").insert({
    location_id: locationId,
    location_name: locationName,
    latitude,
    longitude,
    radius,
  });

  if (error) {
    return { error: error.message.includes("duplicate") ? "That location ID already exists." : error.message };
  }

  revalidatePath("/admin/locations");
}

export async function updateLocation(
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const locationId = String(formData.get("location_id") ?? "").trim();
  const locationName = String(formData.get("location_name") ?? "").trim();
  const latitude = parseCoord(formData.get("latitude"), "Latitude");
  const longitude = parseCoord(formData.get("longitude"), "Longitude");
  const radius = Number(formData.get("radius") ?? 100);

  if (!locationId || !locationName) {
    return { error: "Location ID and name are required." };
  }
  if (typeof latitude !== "number") return latitude;
  if (typeof longitude !== "number") return longitude;
  if (!Number.isFinite(radius) || radius <= 0) {
    return { error: "Radius must be a positive number of metres." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("locations")
    .update({ location_name: locationName, latitude, longitude, radius })
    .eq("location_id", locationId);

  if (error) return { error: error.message };

  revalidatePath("/admin/locations");
}
