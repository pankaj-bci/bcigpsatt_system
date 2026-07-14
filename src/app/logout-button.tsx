"use client";

import { logout } from "@/app/actions/auth";

export function LogoutButton({
  className = "rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50",
}: {
  className?: string;
}) {
  return (
    <button onClick={() => logout()} className={className}>
      Log out
    </button>
  );
}
