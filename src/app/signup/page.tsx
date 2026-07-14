import Link from "next/link";
import { getActiveEmployeeOptions } from "@/app/actions/auth";
import { SignupForm } from "./signup-form";

export const dynamic = "force-dynamic";

export default async function SignupPage() {
  const employees = await getActiveEmployeeOptions();

  return (
    <main className="flex min-h-full flex-1 flex-col items-center justify-center bg-zinc-100 px-4 py-12">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-sm ring-1 ring-zinc-100">
        <p className="text-sm font-bold tracking-wide text-blue-600">BCI</p>
        <h1 className="text-xl font-semibold text-zinc-900">Create your account</h1>
        <p className="mt-1 text-sm text-zinc-500">
          One-time setup. You&apos;ll use this email + password to log in from now on.
        </p>
        <SignupForm employees={employees} />
        <p className="mt-6 text-center text-sm text-zinc-500">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-blue-600 underline">
            Log in
          </Link>
        </p>
      </div>
    </main>
  );
}
