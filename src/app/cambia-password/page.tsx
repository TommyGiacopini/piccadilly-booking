import { PasswordChangeForm } from "@/app/cambia-password/password-change-form";
import { BrandLogo } from "@/app/_components/ui/brand-logo";
import { Button } from "@/app/_components/ui/button";
import { requireSessionUser } from "@/server/auth/authorization";

export const dynamic = "force-dynamic";

export default async function ChangePasswordPage() {
  const user = await requireSessionUser("/cambia-password");

  return (
    <main className="flex min-h-screen items-center justify-center bg-shell px-5 py-10 sm:px-8">
      <section className="w-full max-w-[440px] overflow-hidden rounded-surface border border-border bg-surface-elevated">
        <div className="flex min-h-28 items-center bg-shell px-7 py-6 sm:px-9">
          <BrandLogo className="w-[172px]" decorative priority />
        </div>
        <div className="px-7 py-8 sm:px-9 sm:py-10">
          <p className="text-xs font-semibold tracking-[0.14em] text-brand-primary uppercase">
            Account {user.username}
          </p>
          <h1 className="mt-2 text-heading-md font-semibold tracking-[-0.02em] text-text-primary">
            Imposta una nuova password
          </h1>
          <p className="mt-3 text-sm text-text-secondary">
            Dopo il salvataggio tutte le sessioni saranno chiuse e dovrai autenticarti di nuovo.
          </p>
          <PasswordChangeForm mandatory={user.mustChangePassword} />
          <form action="/api/auth/logout" className="mt-3" method="post">
            <Button fullWidth type="submit" variant="quiet">
              Esci senza cambiare
            </Button>
          </form>
        </div>
      </section>
    </main>
  );
}
