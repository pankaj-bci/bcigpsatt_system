import { createClient } from "@/lib/supabase/server";
import { EditLocationForm } from "./edit-location-form";
import { AddLocationForm } from "./add-location-form";

export const dynamic = "force-dynamic";

export default async function AdminLocationsPage() {
  const supabase = await createClient();
  const { data: locations } = await supabase
    .from("locations")
    .select("location_id, location_name, latitude, longitude, radius")
    .order("location_id");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-zinc-900">Locations</h2>
        <p className="text-sm text-zinc-500">
          Punch geofencing checks against these coordinates + radius. WFH and Other use
          inverted distance-from-Head-Office rules and aren&apos;t rows here.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {(locations ?? []).map((loc) => (
          <EditLocationForm key={loc.location_id} location={loc} />
        ))}
        {(locations ?? []).length === 0 && (
          <p className="text-sm text-zinc-500">No locations yet.</p>
        )}
      </div>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-zinc-900">Add a location</h3>
        <AddLocationForm />
      </div>
    </div>
  );
}
