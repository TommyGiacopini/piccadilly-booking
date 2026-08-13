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

interface BookingSettings {
  rollingCapacityCovers: number;
  rollingWindowMinutes: number;
  lunchModificationCutoff: string;
  dinnerModificationCutoff: string;
  managementLinkDurationHours: number;
}

interface CutoffRule {
  id: string;
  dayOfWeek: (typeof DAY_OF_WEEK_VALUES)[number];
  serviceType: (typeof SERVICE_TYPE_VALUES)[number];
  isEnabled: boolean;
  cutoffTime: string;
}

export function BookingSettingsPanel({
  bookingCutoffRules,
  settings,
}: {
  bookingCutoffRules: CutoffRule[];
  settings: BookingSettings;
}) {
  const mutation = useImpactAwareMutation();

  function submitSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void mutation.propose({
      kind: "BOOKING_SETTINGS",
      rollingCapacityCovers: Number(data.get("rollingCapacityCovers")),
      lunchModificationCutoff: String(data.get("lunchModificationCutoff")),
      dinnerModificationCutoff: String(data.get("dinnerModificationCutoff")),
    });
  }

  function submitCutoff(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void mutation.propose({
      kind: "BOOKING_CUTOFF_RULE",
      dayOfWeek: String(data.get("dayOfWeek")) as CutoffRule["dayOfWeek"],
      serviceType: String(data.get("serviceType")) as CutoffRule["serviceType"],
      isEnabled: data.get("isEnabled") === "on",
      cutoffTime: String(data.get("cutoffTime")),
    });
  }

  return (
    <>
      <MutationStatus message={mutation.message} />
      <section className="rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-8">
        <h2 className="text-xl font-black text-zinc-950">Capacità e termini cliente</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-600">
          Il server calcola sempre l&apos;impatto prima del salvataggio. Le
          prenotazioni già confermate non vengono cambiate.
        </p>
        <form className="mt-6 grid gap-5 sm:grid-cols-2" onSubmit={submitSettings}>
          <label className="text-sm font-bold text-zinc-800">
            Capacità massima nella finestra
            <input className={fieldClassName} defaultValue={settings.rollingCapacityCovers} min="1" name="rollingCapacityCovers" required type="number" />
          </label>
          <div className="rounded-2xl bg-zinc-100 p-4 text-sm">
            <p className="font-bold text-zinc-500">Finestra mobile V1</p>
            <p className="mt-1 text-2xl font-black text-zinc-950">{settings.rollingWindowMinutes} minuti</p>
            <p className="mt-1 text-zinc-600">Valore fisso, non modificabile.</p>
          </div>
          <label className="text-sm font-bold text-zinc-800">
            Termine modifica/cancellazione pranzo
            <input className={fieldClassName} defaultValue={settings.lunchModificationCutoff} name="lunchModificationCutoff" required type="time" />
          </label>
          <label className="text-sm font-bold text-zinc-800">
            Termine modifica/cancellazione cena
            <input className={fieldClassName} defaultValue={settings.dinnerModificationCutoff} name="dinnerModificationCutoff" required type="time" />
          </label>
          <div className="sm:col-span-2">
            <button className={buttonClassName} disabled={mutation.busy} type="submit">Verifica e salva impostazioni</button>
          </div>
        </form>
        <p className="mt-5 rounded-2xl border border-zinc-200 px-4 py-3 text-sm text-zinc-600">
          Durata attuale del link personale: {settings.managementLinkDurationHours} ore. È modificabile nella configurazione pubblica e il nuovo valore si applica soltanto ai link creati successivamente.
        </p>
      </section>

      <section className="mt-6 rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-8">
        <h2 className="text-xl font-black text-zinc-950">Cutoff nuove prenotazioni pubbliche</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-600">
          Ogni giorno e servizio ha una regola indipendente. Il cutoff non blocca le prenotazioni telefoniche Staff/Admin.
        </p>
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          {DAY_OF_WEEK_VALUES.flatMap((dayOfWeek) =>
            SERVICE_TYPE_VALUES.map((serviceType) => {
              const rule = bookingCutoffRules.find(
                (candidate) => candidate.dayOfWeek === dayOfWeek && candidate.serviceType === serviceType,
              );
              return (
                <form className="min-w-0 rounded-2xl border border-zinc-200 p-4" key={`${dayOfWeek}-${serviceType}`} onSubmit={submitCutoff}>
                  <input name="dayOfWeek" type="hidden" value={dayOfWeek} />
                  <input name="serviceType" type="hidden" value={serviceType} />
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="font-black text-zinc-950">{DAY_LABELS[dayOfWeek]}</h3>
                      <p className="text-sm font-bold text-orange-700">{SERVICE_LABELS[serviceType]}</p>
                    </div>
                    <label className="flex items-center gap-2 text-sm font-bold">
                      <input defaultChecked={rule?.isEnabled ?? false} name="isEnabled" type="checkbox" />
                      Attiva
                    </label>
                  </div>
                  <label className="mt-4 block text-xs font-bold text-zinc-700">
                    Orario di chiusura pubblica
                    <input className={fieldClassName} defaultValue={rule?.cutoffTime ?? "17:30"} name="cutoffTime" required type="time" />
                  </label>
                  <button className={`${buttonClassName} mt-4 w-full sm:w-auto`} disabled={mutation.busy} type="submit">Verifica e salva regola</button>
                </form>
              );
            }),
          )}
        </div>
      </section>

      <ImpactConfirmationDialog busy={mutation.busy} onCancel={mutation.cancel} onConfirm={() => void mutation.confirm()} preview={mutation.pendingPreview} />
    </>
  );
}
