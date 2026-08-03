import {
  buttonClassName,
  ConfigurationShell,
  fieldClassName,
  StatusBanner,
} from "@/app/admin/_components/configuration-shell";
import { getOperationalConfiguration } from "@/modules/configuration/application/configuration-service";
import { requireAdmin } from "@/server/auth/authorization";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ message?: string; status?: string }>;
}

export default async function RoomsPage({ searchParams }: PageProps) {
  const user = await requireAdmin("/admin/rooms");
  const configuration = await getOperationalConfiguration(user.restaurantId);
  const parameters = await searchParams;

  return (
    <ConfigurationShell
      description="Sale ordinate e tavoli dimostrativi. Non rappresentano una planimetria e non eseguono assegnazioni automatiche."
      title="Sale e tavoli"
    >
      <StatusBanner
        message={parameters.message}
        status={parameters.status}
      />

      <div className="space-y-5">
        {configuration.rooms.map((room) => (
          <section
            className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm"
            key={room.id}
          >
            <form
              action="/api/admin/configuration"
              className="grid items-end gap-4 sm:grid-cols-[1fr_140px_auto_auto]"
              method="post"
            >
              <input name="action" type="hidden" value="update-room" />
              <input name="id" type="hidden" value={room.id} />
              <div>
                <h2 className="text-xl font-black text-zinc-950">{room.name}</h2>
                <p className="mt-1 text-xs text-zinc-500">Codice stabile: {room.code}</p>
              </div>
              <label className="text-sm font-bold">
                Ordine
                <input
                  className={fieldClassName}
                  defaultValue={room.displayOrder}
                  min="0"
                  name="displayOrder"
                  required
                  type="number"
                />
              </label>
              <label className="flex items-center gap-2 pb-2 text-sm font-bold">
                <input
                  defaultChecked={room.isActive}
                  name="isActive"
                  type="checkbox"
                />
                Attiva
              </label>
              <button className={buttonClassName} type="submit">
                Salva sala
              </button>
            </form>

            <div className="mt-6 space-y-3 border-t border-zinc-200 pt-5">
              {room.diningTables.map((table) => (
                <form
                  action="/api/admin/configuration"
                  className="grid items-end gap-3 rounded-2xl bg-zinc-100 p-4 sm:grid-cols-6"
                  key={table.id}
                  method="post"
                >
                  <input name="action" type="hidden" value="update-table" />
                  <input name="id" type="hidden" value={table.id} />
                  <label className="text-xs font-bold sm:col-span-2">
                    Tavolo demo
                    <input
                      className={fieldClassName}
                      defaultValue={table.name}
                      maxLength={40}
                      name="name"
                      required
                    />
                  </label>
                  <label className="text-xs font-bold">
                    Min
                    <input
                      className={fieldClassName}
                      defaultValue={table.minimumSeats}
                      min="1"
                      name="minimumSeats"
                      required
                      type="number"
                    />
                  </label>
                  <label className="text-xs font-bold">
                    Max
                    <input
                      className={fieldClassName}
                      defaultValue={table.maximumSeats}
                      min="1"
                      name="maximumSeats"
                      required
                      type="number"
                    />
                  </label>
                  <label className="text-xs font-bold">
                    Ordine
                    <input
                      className={fieldClassName}
                      defaultValue={table.displayOrder}
                      min="0"
                      name="displayOrder"
                      required
                      type="number"
                    />
                  </label>
                  <div className="flex items-center justify-between gap-3">
                    <label className="flex items-center gap-2 text-xs font-bold">
                      <input
                        defaultChecked={table.isActive}
                        name="isActive"
                        type="checkbox"
                      />
                      Attivo
                    </label>
                    <button className={buttonClassName} type="submit">
                      Salva
                    </button>
                  </div>
                </form>
              ))}
            </div>
          </section>
        ))}
      </div>
    </ConfigurationShell>
  );
}
