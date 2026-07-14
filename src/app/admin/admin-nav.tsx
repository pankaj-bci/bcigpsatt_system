"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/admin", label: "Today" },
  { href: "/admin/reports", label: "Reports" },
  { href: "/admin/leave-requests", label: "Leave Requests" },
  { href: "/admin/punch-logs", label: "Punch Logs" },
  { href: "/admin/employees", label: "Employees" },
  { href: "/admin/employees/add", label: "Add Employee" },
  { href: "/admin/locations", label: "Add Location" },
  { href: "/admin/holidays", label: "Holidays" },
];

export function AdminNav() {
  const pathname = usePathname();

  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-zinc-200 pb-2">
      {TABS.map((tab) => {
        const active =
          tab.href === "/admin" ? pathname === "/admin" : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`shrink-0 rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap ${
              active ? "bg-blue-600 text-white" : "text-zinc-600 hover:bg-zinc-100"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
