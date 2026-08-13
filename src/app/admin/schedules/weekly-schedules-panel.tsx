"use client";

import type { FormEvent } from "react";

import {
  ImpactConfirmationDialog,
  MutationStatus,
  useImpactAwareMutation,
} from "@/app/admin/_components/impact-confirmation";
import {
  buttonClassName,
  fieldClassName,
} from "@/app/admin/_components/configuration-shell";
import {
  DAY_LABELS,
  DAY_OF_WEEK_VALUES,
  SERVICE_LABELS,
  SERVICE_TYPE_VALUES,
} from "@/modules/configuration/domain/defaults";

interface WeeklySchedule {
  id: string;
  dayOfWeek: (typeof DAY_OF_WEEK_VALUES)[number];
  serviceType: (typeof SERVICE_TYPE_VALUES)[number];
  isEnabled: boolean;
  startTime: string;
  endTime: string;
  slotIntervalMinutes: number;
}

export function WeeklySchedulesPanel({
  schedules,
}: {
  schedules: WeeklySchedule[];
}) {
  const mutation = useImpactAwareMutation();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void mutation.propose({
      kind: "WEEKLY_SCHEDULE",
      id: String(data.get("id")),
      dayOfWeek: String(data.get("dayOfWeek")) as WeeklySchedule["dayOfWeek"],
      serviceType: String(data.get("serviceType")) as WeeklySchedule["serviceType"],
      isEnabled: data.get("isEnabled") === "on",
      startTime: String(data.get("startTime")),
      endTime: String(data.get("endTime")),
    });
  }

  return (
    <>
      <MutationStatus message={mutation.message} />
      <aside className="mb-5 rounded-2xl border border-orange-200 bg-orange-50 p-4 text-sm font-bold text-orange-950">
        Gli slot sono fissi ogni 15 minuti. Le date straordinarie attive
        continuano ad avere precedenza su apertura, orari e capacità.
      </aside>
      <div className="grid gap-4 lg:grid-cols-2">
        {schedules.map((schedule) => (
          <form className="min-w-0 rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm" key={schedule.id} onSubmit={submit}>
            <input name="id" type="hidden" value={schedule.id} />
            <input name="dayOfWeek" type="hidden" value={schedule.dayOfWeek} />
            <input name="serviceType" type="hidden" value={schedule.serviceType} />
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-black">{DAY_LABELS[schedule.dayOfWeek]}</h2>
                <p className="text-sm font-bold text-orange-700">{SERVICE_LABELS[schedule.serviceType]}</p>
              </div>
              <label className="flex items-center gap-2 text-sm font-bold">
                <input defaultChecked={schedule.isEnabled} name="isEnabled" type="checkbox" />
                Servizio abilitato
              </label>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <label className="text-xs font-bold">
                Inizio
                <input className={fieldClassName} defaultValue={schedule.startTime} name="startTime" required type="time" />
              </label>
              <label className="text-xs font-bold">
                Fine
                <input className={fieldClassName} defaultValue={schedule.endTime} name="endTime" required type="time" />
              </label>
              <div className="rounded-xl bg-zinc-100 p-3 text-xs">
                <p className="font-bold text-zinc-500">Intervallo fisso</p>
                <p className="mt-1 text-xl font-black">{schedule.slotIntervalMinutes} min</p>
              </div>
            </div>
            <button className={`${buttonClassName} mt-5 w-full sm:w-auto`} disabled={mutation.busy} type="submit">Verifica e salva servizio</button>
          </form>
        ))}
      </div>
      <ImpactConfirmationDialog busy={mutation.busy} onCancel={mutation.cancel} onConfirm={() => void mutation.confirm()} preview={mutation.pendingPreview} />
    </>
  );
}
