"use client";

export function MonthPicker({ month }: { month: string }) {
  return (
    <form>
      <input
        type="month"
        name="month"
        defaultValue={month}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="h-9 rounded-lg border border-zinc-300 px-3 text-sm focus:border-blue-600 focus:outline-none"
      />
    </form>
  );
}
