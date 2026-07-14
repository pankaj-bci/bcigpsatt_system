"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/staff", label: "Punch", icon: "📍" },
  { href: "/staff/dashboard", label: "Dashboard", icon: "📊" },
  { href: "/staff/leave", label: "Leave", icon: "🗓️" },
];

export function StaffNav() {
  const pathname = usePathname();

  return (
    <nav className="mt-auto grid grid-cols-3 border-t border-zinc-200 bg-white">
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`flex flex-col items-center gap-0.5 py-3 text-xs font-medium ${
              active ? "text-blue-600" : "text-zinc-400"
            }`}
          >
            <span aria-hidden className="text-lg">
              {tab.icon}
            </span>
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
