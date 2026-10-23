"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ComponentProps, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useStaffDraftHost, useStaffHostView, useStaffOverlay } from "@/app/_components/staff/staff-draft-host";

import { BrandLogo } from "@/app/_components/ui/brand-logo";

import {
  adminHub, isStaffNavigationActive, navigationGroupForPath,
  navigationGroupsForRole, staffBreadcrumbs,
  type NavigationIcon, type StaffRole,
} from "@/app/_components/staff/staff-navigation";

export function StaffNavigationLink({ href, onAccepted, ...props }: Omit<ComponentProps<typeof Link>, "href" | "onNavigate"> & { href: string; onAccepted?: () => void }) {
  const controller = useStaffDraftHost(), router = useRouter();
  return <Link {...props} prefetch={false} href={href} onNavigate={event => {
    event.preventDefault();
    controller.requestExit(() => {
      onAccepted?.();
      controller.prepareNavigation();
      router.push(href);
    });
  }} />;
}

export function AdminSectionNavigation() {
  const pathname = usePathname(), group = navigationGroupForPath(pathname);
  if (!group || group.id === "operations") return null;
  return <nav aria-label={"Navigazione " + group.label} className="mt-5 flex flex-wrap gap-2">
    {group.items.map(item => <StaffNavigationLink key={item.href} href={item.href}
      aria-current={isStaffNavigationActive(pathname, item.href) ? "page" : undefined}
      className={"inline-flex min-h-11 items-center rounded-control border px-4 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-copper " + (isStaffNavigationActive(pathname, item.href) ? "border-brand-copper bg-surface text-text-primary underline underline-offset-4" : "border-border bg-white text-text-secondary hover:border-brand-copper")}>
      {item.label}
    </StaffNavigationLink>)}
  </nav>;
}

function StaffBreadcrumb({ role }: { role: StaffRole }) {
  const items = staffBreadcrumbs(usePathname(), role);
  if (!items.length) return null;
  return <nav aria-label="Fil d’Arianna" className="border-b border-border px-4 py-2 text-sm text-text-secondary sm:px-8">
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">{items.map((item, index) => <li key={item.label} className="flex min-w-0 items-center gap-2">
      {index > 0 ? <span aria-hidden="true">›</span> : null}
      {item.href ? <StaffNavigationLink href={item.href} aria-label={"Vai a " + item.label} className="inline-flex min-h-11 items-center rounded-control underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-brand-copper">{item.label}</StaffNavigationLink>
        : <span aria-current={index === items.length - 1 ? "page" : undefined}>{item.label}</span>}
    </li>)}</ol>
  </nav>;
}

function Icon({ name }: { name: NavigationIcon | "close" | "menu" | "key" | "logout" }) {
  const paths = {
    agenda: (
      <>
        <path d="M5 3v3M15 3v3M3 8h14" />
        <rect height="14" rx="2" width="16" x="2" y="4" />
        <path d="M6 12h3M11 12h3M6 15h3" />
      </>
    ),
    add: (
      <>
        <path d="M10 4v12M4 10h12" />
        <circle cx="10" cy="10" r="8" />
      </>
    ),
    settings: (
      <>
        <circle cx="10" cy="10" r="3" />
        <path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M15.7 4.3l-1.4 1.4M5.7 14.3l-1.4 1.4" />
      </>
    ),
    admin: (
      <>
        <circle cx="10" cy="7" r="3" />
        <path d="M4 18c.5-4 2.5-6 6-6s5.5 2 6 6" />
      </>
    ),
    menu: <path d="M3 6h14M3 10h14M3 14h14" />,
    close: <path d="m4 4 12 12M16 4 4 16" />,
    key: (
      <>
        <circle cx="7" cy="10" r="4" />
        <path d="M11 10h7M15 10v3M18 10v2" />
      </>
    ),
    logout: (
      <>
        <path d="M8 3H4v14h4M12 6l4 4-4 4M7 10h9" />
      </>
    ),
  } as const;

  return (
    <svg
      aria-hidden="true"
      className="size-5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 20 20"
    >
      {paths[name]}
    </svg>
  );
}

function Navigation({ mobile = false, onNavigate, pathname, role }: {
  mobile?: boolean; onNavigate?: () => void; pathname: string; role: StaffRole;
}) {
  function itemLink(item: { href: string; label: string; icon: NavigationIcon }) {
    const active = isStaffNavigationActive(pathname, item.href);
    return <StaffNavigationLink key={item.href} href={item.href} onAccepted={onNavigate}
      aria-current={active ? "page" : undefined} aria-label={item.label} title={item.label} data-nav-label={item.label}
      className={`relative flex min-h-11 items-center gap-3 rounded-r-control px-4 py-2 text-sm text-shell-text before:absolute before:inset-y-0 before:left-0 before:w-[3px] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand-copper ${active ? "bg-shell-selected font-semibold before:bg-brand-copper" : "font-medium before:bg-transparent hover:bg-shell-hover"} ${mobile ? "" : "md:justify-center md:px-0 lg:justify-start lg:px-4"}`}>
      <Icon name={item.icon} /><span className={mobile ? "min-w-0" : "min-w-0 md:sr-only lg:not-sr-only"}>{item.label}</span>
    </StaffNavigationLink>;
  }
  return <nav aria-label="Navigazione area Staff" className="space-y-4 pb-2">
    {navigationGroupsForRole(role).map(group => <section key={group.id} aria-label={group.label}>
      <h2 className={"mb-1 px-4 text-[11px] font-semibold tracking-wide text-shell-text-secondary uppercase " + (mobile ? "" : "md:sr-only lg:not-sr-only")}>{group.label}</h2>
      <div className="space-y-1">{group.items.map(itemLink)}</div>
    </section>)}
    {role === "ADMIN" ? <div className="border-t border-white/15 pt-2">{itemLink(adminHub)}</div> : null}
  </nav>;
}

function AccountActions({
  mobile = false,
  onNavigate,
  role,
  username,
}: {
  mobile?: boolean;
  onNavigate?: () => void;
  role: StaffRole;
  username: string;
}) {
  const controller = useStaffDraftHost();
  return (
    <div className="border-t border-white/15 pt-3">
      <div className={mobile ? "mb-3 px-4" : "mb-3 hidden px-4 lg:block"}>
        <p className="truncate text-sm font-semibold text-shell-text">{username}</p>
        <p className="mt-0.5 text-xs text-shell-text-secondary">
          {role === "ADMIN" ? "Amministratore" : "Staff"}
        </p>
      </div>
      <StaffNavigationLink
        aria-label="Cambia password"
        className={`flex min-h-11 items-center gap-3 rounded-control px-4 text-sm font-medium text-shell-text-secondary hover:bg-shell-hover hover:text-shell-text ${
          mobile ? "" : "md:justify-center md:px-0 lg:justify-start lg:px-4"
        }`}
        href="/cambia-password"
        onAccepted={onNavigate}
        title="Cambia password"
      >
        <Icon name="key" />
        <span className={mobile ? "" : "md:sr-only lg:not-sr-only"}>Password</span>
      </StaffNavigationLink>
      <form action="/api/auth/logout" method="post" onSubmit={(event) => { event.preventDefault(); controller.requestLogout(event.currentTarget); }}>
        <button
          aria-label="Logout"
          className={`flex min-h-11 w-full items-center gap-3 rounded-control px-4 text-sm font-medium text-shell-text-secondary hover:bg-shell-hover hover:text-shell-text ${
            mobile ? "" : "md:justify-center md:px-0 lg:justify-start lg:px-4"
          }`}
          type="submit"
        >
          <Icon name="logout" />
          <span className={mobile ? "" : "md:sr-only lg:not-sr-only"}>Esci</span>
        </button>
      </form>
    </div>
  );
}

export function StaffShell({
  children,
  role,
  username,
}: {
  children: ReactNode;
  role: StaffRole;
  username: string;
}) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuReturnFocusRef = useRef<HTMLElement | null>(null);
  const controller = useStaffDraftHost(), hostView = useStaffHostView();
  const deferredMenuFocus = useRef<{ guardId: string; pathname: string } | null>(null);
  function acceptMenuNavigation() {
    deferredMenuFocus.current = null;
    setDrawerOpen(false);
  }
  const closeMenu = useCallback(() => {
    menuReturnFocusRef.current = null;
    setDrawerOpen(false);
    const guard = controller.getSnapshot().guard;
    if (guard) {
      // The mobile trigger may disappear at the breakpoint. Keep focus owned
      // by the guard until Stay; accepted navigation cancels this fallback.
      deferredMenuFocus.current = { guardId: guard.id, pathname };
      return;
    }
    requestAnimationFrame(() => {
      const current = controller.getSnapshot();
      if (current.guard || current.overlay) return;
      const button = menuButtonRef.current;
      if (button?.getClientRects().length) button.focus();
      else document.getElementById("staff-main-content")?.focus();
    });
  }, [controller, pathname]);
  useEffect(() => {
    const pending = deferredMenuFocus.current;
    if (!pending) return;
    if (pathname !== pending.pathname || (hostView.guard && hostView.guard.id !== pending.guardId)) { deferredMenuFocus.current = null; return; }
    if (hostView.guard || hostView.overlay) return;
    deferredMenuFocus.current = null;
    const frame = requestAnimationFrame(() => {
      const current = controller.getSnapshot(), target = document.getElementById("staff-main-content");
      if (!current.guard && !current.overlay && controller.sessionVisible() && window.location.pathname === pending.pathname && target?.getClientRects().length && !target.closest("[inert],[hidden]")) target.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [controller, hostView.guard, hostView.overlay, pathname]);
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px)");
    function resize() { if (desktop.matches && drawerOpen) closeMenu(); }
    desktop.addEventListener("change", resize);
    return () => desktop.removeEventListener("change", resize);
  }, [closeMenu, drawerOpen]);
  const menuActive = useStaffOverlay(drawerOpen, "staff-mobile-menu", drawerRef, closeMenu);
  useEffect(() => {
    if (!menuActive) return;
    const target = menuReturnFocusRef.current;
    menuReturnFocusRef.current = null;
    if (!target) return;
    // Restore the menu trigger after the host releases the exit dialog's inert
    // state. The host remains the sole focus-trap and scroll-lock owner.
    const frame = requestAnimationFrame(() => {
      if (target.isConnected && drawerRef.current?.contains(target) && !target.closest("[inert]")) target.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [menuActive]);

  return (
    <div className="min-h-screen bg-page-background" data-staff-shell>
      <a className="skip-link" href="#staff-main-content">
        Vai al contenuto principale
      </a>

      <aside
        aria-label="Area Staff"
        className="fixed inset-y-0 left-0 z-40 hidden h-dvh w-[72px] flex-col bg-shell md:flex lg:w-[216px]"
        data-testid="staff-sidebar"
      >
        <div className="hidden min-h-24 items-center px-5 lg:flex">
          <BrandLogo className="w-[150px]" priority />
        </div>
        <div aria-hidden="true" className="mx-auto my-6 h-1 w-7 bg-brand-copper lg:hidden" />
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 lg:px-3">
          <Navigation pathname={pathname} role={role} />
        </div>
        <div className="shrink-0 p-2 pb-4 lg:p-3 lg:pb-5">
          <AccountActions role={role} username={username} />
        </div>
      </aside>

      <header className="sticky top-0 z-30 flex h-14 items-center justify-between bg-shell px-4 md:hidden">
        <BrandLogo className="w-[120px]" priority />
        <button
          aria-controls="staff-mobile-navigation"
          aria-expanded={drawerOpen}
          aria-label="Apri navigazione"
          className="inline-flex size-11 items-center justify-center rounded-control text-shell-text hover:bg-shell-hover"
          onClick={() => setDrawerOpen(true)}
          ref={menuButtonRef}
          type="button"
        >
          <Icon name="menu" />
        </button>
      </header>

      {drawerOpen ? (
        <div className="fixed inset-0 z-[1100] md:hidden"
            aria-label="Menu area Staff"
            aria-modal={menuActive || undefined}
            id="staff-mobile-navigation"
            ref={drawerRef}
            role={menuActive ? "dialog" : undefined}
            inert={!menuActive}
            tabIndex={-1}
            onClickCapture={event => {
              if (event.target instanceof Element) menuReturnFocusRef.current = event.target.closest<HTMLElement>("a,button");
            }}
          >
          <aside className="absolute inset-y-0 left-0 z-10 flex w-[min(86vw,320px)] flex-col bg-shell p-4 shadow-2xl">
            <div className="flex min-h-14 items-center justify-between">
              <BrandLogo className="w-[124px]" />
              <button
                aria-label="Chiudi menu"
                className="inline-flex size-11 items-center justify-center rounded-control text-shell-text hover:bg-shell-hover"
                onClick={closeMenu}
                ref={closeButtonRef}
                type="button"
              >
                <Icon name="close" />
              </button>
            </div>
            <div className="mt-4 min-h-0 flex-1 overflow-y-auto overscroll-contain">
              <Navigation
                mobile
                onNavigate={acceptMenuNavigation}
                pathname={pathname}
                role={role}
              />
            </div>
            <AccountActions
              mobile
              onNavigate={acceptMenuNavigation}
              role={role}
              username={username}
            />
          </aside>
          <div aria-hidden="true" data-staff-menu-backdrop className="absolute inset-0 bg-black/55" onPointerDown={closeMenu} />
        </div>
      ) : null}

      <div
        className="min-w-0 md:ml-[72px] lg:ml-[216px]"
        id="staff-main-content"
        tabIndex={-1}
      >
        <StaffBreadcrumb role={role} />
        {children}
      </div>
    </div>
  );
}
