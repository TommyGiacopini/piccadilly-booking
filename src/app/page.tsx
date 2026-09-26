import { BrandLogo } from "@/app/_components/ui/brand-logo";
import { ButtonLink } from "@/app/_components/ui/button";

export default function Home() {
  return (
    <main
      className="flex min-h-screen items-center justify-center bg-shell px-5 py-14 text-shell-text sm:px-8"
      id="main-content"
    >
      <section className="w-full max-w-[440px] text-center">
        <BrandLogo
          className="mx-auto w-[196px] sm:w-[212px]"
          decorative
          priority
        />
        <h1 className="mt-12 text-heading-lg font-semibold tracking-[-0.02em] text-white">
          Prenotazioni Piccadilly
        </h1>
        <p className="mx-auto mt-4 max-w-sm text-md text-shell-text-secondary">
          Prenota online oppure accedi all’area riservata.
        </p>
        <div className="mt-9 flex flex-col gap-3 sm:flex-row">
          <ButtonLink className="sm:flex-1" fullWidth href="/prenota">
            Prenota un tavolo
          </ButtonLink>
          <ButtonLink
            className="sm:flex-1"
            fullWidth
            href="/login"
            variant="secondaryInverse"
          >
            Area Staff
          </ButtonLink>
        </div>
      </section>
    </main>
  );
}
