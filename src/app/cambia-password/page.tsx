import { PasswordChangeForm } from "@/app/cambia-password/password-change-form";
import { requireSessionUser } from "@/server/auth/authorization";

export const dynamic = "force-dynamic";

export default async function ChangePasswordPage() {
  const user = await requireSessionUser("/cambia-password");

  return (
    <main className="flex min-h-screen items-center justify-center px-5 py-12 sm:px-8">
      <section className="w-full max-w-md rounded-3xl border border-zinc-200 bg-white p-8 shadow-[0_24px_80px_rgba(0,0,0,0.08)] sm:p-10">
        <p className="text-xs font-black tracking-[0.18em] text-orange-600 uppercase">Account {user.username}</p>
        <h1 className="mt-3 text-3xl font-black tracking-tight text-zinc-950">Cambia password</h1>
        <p className="mt-3 leading-6 text-zinc-600">Dopo il salvataggio tutte le sessioni saranno chiuse e dovrai autenticarti di nuovo.</p>
        <PasswordChangeForm mandatory={user.mustChangePassword} />
        <form action="/api/auth/logout" className="mt-4" method="post">
          <button className="w-full rounded-xl border border-zinc-300 px-5 py-3 font-bold text-zinc-800" type="submit">Esci senza cambiare</button>
        </form>
      </section>
    </main>
  );
}
