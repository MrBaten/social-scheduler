"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { api, ApiError } from "./api";
import { Button } from "./Button";
import { Brand } from "./AppNav";

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isSignup = mode === "signup";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (isSignup && password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      await api(isSignup ? "/api/auth/signup" : "/api/auth/login", {
        method: "POST",
        json: isSignup ? { email, name, password } : { email, password },
        noAuthRedirect: true,
      });
      router.push("/compose");
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setError("Incorrect email or password.");
      else setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  }

  const input =
    "mt-1 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm " +
    "placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20";

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Brand />
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
          <h1 className="text-xl font-semibold tracking-tight text-gray-900">{isSignup ? "Create your account" : "Welcome back"}</h1>
          <p className="mt-1 text-sm text-gray-500">
            {isSignup ? "Schedule posts to every platform from one place." : "Log in to manage your scheduled posts."}
          </p>
          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            {isSignup && (
              <label className="block">
                <span className="text-sm font-medium text-gray-700">Name</span>
                <input className={input} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="Ada Lovelace" required />
              </label>
            )}
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Email</span>
              <input
                className={input}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                placeholder="you@example.com"
                required
              />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Password</span>
              <input
                className={input}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={isSignup ? "new-password" : "current-password"}
                minLength={isSignup ? 8 : undefined}
                required
              />
            </label>
            {error && (
              <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            )}
            <Button type="submit" size="md" className="w-full" loading={busy}>
              {isSignup ? "Create account" : "Log in"}
            </Button>
          </form>
        </div>
        <p className="mt-6 text-center text-sm text-gray-500">
          {isSignup ? (
            <>
              Already have an account?{" "}
              <Link href="/login" className="font-medium text-indigo-600 hover:text-indigo-500">
                Log in
              </Link>
            </>
          ) : (
            <>
              New here?{" "}
              <Link href="/signup" className="font-medium text-indigo-600 hover:text-indigo-500">
                Create an account
              </Link>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
