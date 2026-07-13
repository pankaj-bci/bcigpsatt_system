"use client";

import { useActionState } from "react";
import { login } from "@/app/actions/auth";

export function LoginForm() {
  const [state, formAction, pending] = useActionState(login, undefined);

  return (
    <form action={formAction} className="mt-6 flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="email" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className="h-12 rounded-lg border border-zinc-300 px-4 text-base dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-50"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="password" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="h-12 rounded-lg border border-zinc-300 px-4 text-base dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-50"
        />
      </div>
      {state?.error && (
        <p className="text-sm text-red-600 dark:text-red-400">{state.error}</p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="h-12 rounded-lg bg-zinc-900 text-base font-medium text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
      >
        {pending ? "Logging in…" : "Log in"}
      </button>
    </form>
  );
}
