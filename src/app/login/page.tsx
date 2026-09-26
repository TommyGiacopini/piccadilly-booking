import { redirect } from "next/navigation";

import { Alert } from "@/app/_components/ui/alert";
import { BrandLogo } from "@/app/_components/ui/brand-logo";
import { LoginForm } from "@/app/login/login-form";
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
        ? "Nome utente o password non corretti."
        : null;

  return (
    <main className="flex min-h-screen items-center justify-center bg-shell px-5 py-10 sm:px-8">
      <section className="w-full max-w-[440px] overflow-hidden rounded-surface border border-border bg-surface-elevated">
        <div className="flex min-h-28 items-center bg-shell px-7 py-6 sm:px-9">
          <BrandLogo className="w-[172px]" decorative priority />
        </div>
        <div className="px-7 py-8 sm:px-9 sm:py-10">
          <p className="text-xs font-semibold tracking-[0.14em] text-brand-primary uppercase">
            Piccadilly Booking
          </p>
          <h1 className="mt-2 text-heading-lg font-semibold tracking-[-0.02em] text-text-primary">
            Area Staff
          </h1>
          <p className="mt-3 text-md text-text-secondary">
            Accedi per gestire le prenotazioni.
          </p>

          {parameters.passwordChanged === "1" ? (
            <div className="mt-6">
              <Alert tone="success">
                Password aggiornata. Accedi di nuovo per continuare all’Agenda.
              </Alert>
            </div>
          ) : null}

          {errorMessage ? (
            <div className="mt-6">
              <Alert>{errorMessage}</Alert>
            </div>
          ) : null}

          <LoginForm returnTo={returnTo} />
        </div>
      </section>
    </main>
  );
}
