import { getTodayDashboard } from "./today-data";
import { TodayDashboardClient } from "./today-dashboard-client";

export const dynamic = "force-dynamic";

export default async function AdminTodayPage() {
  const initialData = await getTodayDashboard();
  return <TodayDashboardClient initialData={initialData} />;
}
