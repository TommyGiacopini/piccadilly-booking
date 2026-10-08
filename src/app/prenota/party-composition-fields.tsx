"use client";

import { useId } from "react";
import type { PartyComposition } from "@/modules/reservations/domain/party-composition";

export interface CompositionFormState {
  mode: "" | "unknown" | "adults" | "children";
  count: string;
  games: "" | "yes" | "no";
}

export function compositionFormState(value?: PartyComposition): CompositionFormState {
  return {
    mode: value ? value.childrenCount === null ? "unknown" : value.childrenCount === 0 ? "adults" : "children" : "",
    count: value?.childrenCount ? String(value.childrenCount) : "",
    games: value?.gameRoomPreference === null || value?.gameRoomPreference === undefined ? "" : value.gameRoomPreference ? "yes" : "no",
  };
}

export function compositionPayload(state: CompositionFormState) {
  return {
    childrenCount: state.mode === "adults" ? 0 : state.mode === "children" ? Number(state.count) : null,
    gameRoomPreference: state.mode === "children" ? state.games === "" ? null : state.games === "yes" : null,
  };
}

export const restaurantDiscretionCopy = {
  it: "La disposizione dei tavoli e delle sale viene definita dal ristorante in base alle esigenze organizzative e di servizio.",
  en: "The restaurant determines the arrangement of tables and rooms according to organisational and service needs.",
} as const;

const copy = {
  it: {
    question: "Ci sono bambini?", unknown: "Non specificato", adults: "No, siamo tutti adulti", children: "Sì, ci sono bambini",
    count: "Quanti bambini ci sono?", games: "Preferite un tavolo nella Sala con i Giochi?", yes: "Sì", no: "No",
    notice: "La richiesta per la Sala con i Giochi non è garantita. In caso di più richieste, daremo priorità, per quanto possibile, all'ordine di prenotazione.",
    invalid: "Il numero di bambini non può superare i coperti totali.",
  },
  en: {
    question: "Are there children?", unknown: "Not specified", adults: "No, we are all adults", children: "Yes, there are children",
    count: "How many children are there?", games: "Would you prefer a table in the Room with Games?", yes: "Yes", no: "No",
    notice: "The request for the Room with Games is not guaranteed. Where possible, we will give priority to requests in booking order.",
    invalid: "The number of children cannot exceed the total covers.",
  },
} as const;

export function PartyCompositionFields({ state, onChange, partySize, allowUnknown = false, language = "it" }: {
  state: CompositionFormState;
  onChange: (value: CompositionFormState) => void;
  partySize: number;
  allowUnknown?: boolean;
  language?: "it" | "en";
}) {
  const id = useId();
  const text = copy[language];
  const invalid = state.mode === "children" && Number(state.count) > partySize;
  const choiceClass = "flex min-h-11 min-w-0 items-center gap-3 rounded-md border border-border bg-surface px-3 py-2 text-md text-text-primary [overflow-wrap:anywhere]";
  return (
    <div className="min-w-0 space-y-4" data-party-composition>
      <fieldset className="min-w-0">
        <legend className="mb-2 font-semibold">{text.question}</legend>
        <div className="flex flex-wrap gap-2">
          {([
            ...(allowUnknown ? [["unknown", text.unknown] as const] : []),
            ["adults", text.adults], ["children", text.children],
          ] as const).map(([mode, label]) => (
            <label className={choiceClass} key={mode}>
              <input checked={state.mode === mode} name={`${id}-composition`} onChange={() => onChange({ mode, count: "", games: "" })} required type="radio" value={mode} />{label}
            </label>
          ))}
        </div>
      </fieldset>
      {state.mode === "children" ? (
        <div className="min-w-0 space-y-4">
          <label className="block font-medium" htmlFor={`${id}-count`}>{text.count}</label>
          <input aria-describedby={`${id}-relative${invalid ? ` ${id}-invalid` : ""}`} aria-invalid={invalid || undefined} className="block min-h-11 w-full min-w-0 rounded-md border border-border bg-surface px-3 text-md" id={`${id}-count`} max={partySize} min={1} name="childrenCount" onChange={(event) => onChange({ ...state, count: event.target.value })} required step={1} type="number" value={state.count} />
          <p className="text-sm text-text-secondary" id={`${id}-relative`} role="status">{state.count || "—"} {language === "it" ? "su" : "of"} {partySize} {language === "it" ? "coperti" : "total covers"}</p>
          {invalid ? <p id={`${id}-invalid`} role="alert">{text.invalid}</p> : null}
          <fieldset aria-describedby={`${id}-notice`} className="min-w-0">
            <legend className="mb-2 font-semibold">{text.games}</legend>
            <div className="flex flex-wrap gap-2">
              {([["yes", text.yes], ["no", text.no]] as const).map(([answer, label]) => (
                <label className={choiceClass} key={answer}><input checked={state.games === answer} name={`${id}-games`} onChange={() => onChange({ ...state, games: answer })} required type="radio" value={answer} />{label}</label>
              ))}
            </div>
            <p className="mt-2 text-sm text-text-secondary [overflow-wrap:anywhere]" id={`${id}-notice`}>{text.notice}</p>
          </fieldset>
        </div>
      ) : null}
    </div>
  );
}
