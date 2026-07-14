import Link from "next/link";
import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <main className="flex min-h-full flex-1 flex-col items-center justify-center bg-zinc-100 px-4 py-12">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-sm ring-1 ring-zinc-100">
        <p className="text-sm font-bold tracking-wide text-blue-600">BCI</p>
        <h1 className="text-xl font-semibold text-zinc-900">GPS Attendance — Log in</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Use the email and password you created when you signed up.
        </p>
        <LoginForm />
        <p className="mt-6 text-center text-sm text-zinc-500">
          First time here?{" "}
          <Link href="/signup" className="font-medium text-blue-600 underline">
            Create your account
          </Link>
        </p>
      </div>
    </main>
  );
}
