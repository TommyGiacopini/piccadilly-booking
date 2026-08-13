import { redirect } from "next/navigation";

import { getCurrentUser } from "@/server/auth/authorization";
import { resolveSafePostLoginPath } from "@/server/auth/request-security";

export const dynamic = "force-dynamic";

interface LoginPageProps {
  searchParams: Promise<{
    error?: string | string[];
    returnTo?: string | string[];
    passwordChanged?: string | string[];
  }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const parameters = await searchParams;
  const returnTo = resolveSafePostLoginPath(parameters.returnTo);
  const currentUser = await getCurrentUser();

  if (currentUser) {
    redirect(currentUser.mustChangePassword ? "/cambia-password" : returnTo);
  }

  const error = Array.isArray(parameters.error)
    ? parameters.error[0]
    : parameters.error;
  const errorMessage =
    error === "rate-limited"
      ? "Troppi tentativi. Attendi alcuni minuti e riprova."
      : error
        ? "Username o password non validi."
        : null;

  return (
    <main className="flex min-h-screen items-center justify-center px-5 py-12 sm:px-8">
      <section className="w-full max-w-md overflow-hidden rounded-3xl border border-zinc-200 bg-white shadow-[0_24px_80px_rgba(0,0,0,0.08)]">
        <div className="h-2 bg-orange-500" />
        <div className="px-7 py-9 sm:px-10 sm:py-11">
          <p className="text-sm font-bold tracking-[0.18em] text-orange-600 uppercase">
            Area personale
          </p>
          <h1 className="mt-3 text-3xl font-black tracking-tight text-zinc-950">
            Piccadilly Booking
          </h1>
          <p className="mt-3 leading-6 text-zinc-600">
            Accedi con il tuo account individuale di servizio.
          </p>

          {parameters.passwordChanged === "1" ? (
            <div className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800" role="status">
              Password aggiornata. Accedi di nuovo con la nuova password.
            </div>
          ) : null}

          {errorMessage ? (
            <div
              className="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-800"
              role="alert"
            >
              {errorMessage}
            </div>
          ) : null}

          <form action="/api/auth/login" className="mt-7 space-y-5" method="post">
            <input name="returnTo" type="hidden" value={returnTo} />

            <label className="block text-sm font-bold text-zinc-800">
              Username
              <input
                autoCapitalize="none"
                autoComplete="username"
                className="mt-2 block w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 text-base font-normal text-zinc-950 outline-none transition focus:border-orange-500 focus:ring-4 focus:ring-orange-100"
                maxLength={64}
                minLength={3}
                name="username"
                required
                spellCheck={false}
                type="text"
              />
            </label>

            <label className="block text-sm font-bold text-zinc-800">
              Password
              <input
                autoComplete="current-password"
                className="mt-2 block w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 text-base font-normal text-zinc-950 outline-none transition focus:border-orange-500 focus:ring-4 focus:ring-orange-100"
                maxLength={128}
                minLength={12}
                name="password"
                required
                type="password"
              />
            </label>

            <button
              className="w-full rounded-xl bg-zinc-950 px-5 py-3.5 text-base font-bold text-white transition hover:bg-orange-600 focus:outline-none focus:ring-4 focus:ring-orange-200"
              type="submit"
            >
              Accedi
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
