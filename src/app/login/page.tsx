import Link from "next/link";
import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <main className="flex min-h-full flex-1 flex-col items-center justify-center bg-zinc-50 px-4 py-12 dark:bg-black">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-sm dark:bg-zinc-900">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
          GPS Attendance — Log in
        </h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Use the email and password you created when you signed up.
        </p>
        <LoginForm />
        <p className="mt-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
          First time here?{" "}
          <Link href="/signup" className="font-medium text-zinc-900 underline dark:text-zinc-50">
            Create your account
          </Link>
        </p>
      </div>
    </main>
  );
}
