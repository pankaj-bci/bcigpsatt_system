"use client";

import { useActionState } from "react";
import { updateLocation } from "./actions";

type Location = {
  location_id: string;
  location_name: string;
  latitude: number;
  longitude: number;
  radius: number;
};

const inputClass =
  "h-10 rounded-lg border border-zinc-300 px-3 text-sm focus:border-blue-600 focus:outline-none";

export function EditLocationForm({ location }: { location: Location }) {
  const [state, formAction, pending] = useActionState(updateLocation, undefined);

  return (
    <form
      action={formAction}
      className="grid grid-cols-2 gap-3 rounded-xl border border-zinc-200 bg-white p-4 sm:grid-cols-5 sm:items-end"
    >
      <input type="hidden" name="location_id" value={location.location_id} />
      <div className="col-span-2 flex flex-col gap-1 sm:col-span-1">
        <span className="text-xs font-medium text-zinc-500">ID</span>
        <p className="text-sm font-semibold text-zinc-900">{location.location_id}</p>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-zinc-500">Name</span>
        <input
          name="location_name"
          defaultValue={location.location_name}
          required
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-zinc-500">Latitude</span>
        <input
          name="latitude"
          type="number"
          step="any"
          defaultValue={location.latitude}
          required
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-zinc-500">Longitude</span>
        <input
          name="longitude"
          type="number"
          step="any"
          defaultValue={location.longitude}
          required
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-zinc-500">Radius (m)</span>
        <input
          name="radius"
          type="number"
          step="1"
          min="1"
          defaultValue={location.radius}
          required
          className={inputClass}
        />
      </label>
      <div className="col-span-2 flex items-center gap-3 sm:col-span-5">
        <button
          type="submit"
          disabled={pending}
          className="h-9 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
      </div>
    </form>
  );
}
