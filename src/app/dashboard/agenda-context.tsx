"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useStaffDraftHost, useStaffHostView } from "@/app/_components/staff/staff-draft-host";
import { safeAgendaOrigin } from "@/modules/dashboard/domain/agenda-navigation";

// This adapter owns no draft or PII. The root host survives this layout.
export function AgendaContext({ children }: { children: ReactNode }) {
  const controller = useStaffDraftHost(), view = useStaffHostView(), pathname = usePathname();
  const wasAgenda = useRef(false), restore = useRef(true);
  useLayoutEffect(() => {
    if (pathname !== "/dashboard") { wasAgenda.current = false; restore.current = true; return; }
    if (!wasAgenda.current) { wasAgenda.current = true; restore.current = true; }
    if (!restore.current || !controller.sessionVisible() || view.overlay || view.guard) return;
    restore.current = false;
    const target = view.agenda.focusReservationId
      ? document.querySelector<HTMLElement>(`[data-reservation-id="${view.agenda.focusReservationId}"] [data-open-reservation]`) : null;
    if (view.agenda.focusReservationId) (target ?? document.getElementById("agenda-controls-title"))?.focus({ preventScroll: true });
    if (view.agenda.scrollY) window.scrollTo({ top: view.agenda.scrollY });
  }, [controller, pathname, view.drafts.auth, view.overlay, view.guard, view.agenda.focusReservationId, view.agenda.scrollY]);
  return children;
}
export function useAgendaContext() {
  const controller = useStaffDraftHost(), view = useStaffHostView(), router = useRouter();
  function remember(originPath: string, focusReservationId: string | null = null) {
    controller.setAgenda({ originPath, focusReservationId, scrollY: window.scrollY });
  }
  function navigate(href: string, keys?: readonly string[]) {
    controller.requestExit(() => { controller.prepareNavigation(); router.push(href); }, keys);
  }
  function origin(date: string) { return safeAgendaOrigin(view.agenda.originPath, date); }
  return { state: view.agenda, controller, remember, navigate, origin };
}
