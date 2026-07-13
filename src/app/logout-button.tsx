"use client";

import { logout } from "@/app/actions/auth";

export function LogoutButton() {
  return (
    <button
      onClick={() => logout()}
      className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
    >
      Log out
    </button>
  );
}
