"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import { BrandLogo } from "@/app/_components/ui/brand-logo";

type StaffRole = "ADMIN" | "STAFF";
type NavigationIcon = "agenda" | "add" | "settings" | "admin";

export interface StaffNavigationItem {
  href: string;
  icon: NavigationIcon;
  label: string;
}

const baseNavigation: StaffNavigationItem[] = [
  { href: "/dashboard", icon: "agenda", label: "Agenda" },
  {
    href: "/dashboard/reservations/new",
    icon: "add",
    label: "Nuova prenotazione",
  },
];

const adminNavigation: StaffNavigationItem[] = [
  {
    href: "/admin/configuration",
    icon: "settings",
    label: "Configurazioni",
  },
  { href: "/admin", icon: "admin", label: "Admin" },
];

export function buildStaffNavigation(role: StaffRole): StaffNavigationItem[] {
  return role === "ADMIN"
    ? [...baseNavigation, ...adminNavigation]
    : [...baseNavigation];
}

export function isStaffNavigationActive(
  pathname: string,
  href: string,
): boolean {
  if (href === "/dashboard/reservations/new") {
    return pathname.startsWith(href);
  }
  if (href === "/dashboard") {
    return (
      pathname === href ||
      (pathname.startsWith("/dashboard/") &&
        !pathname.startsWith("/dashboard/reservations/new"))
    );
  }
  if (href === "/admin/configuration") {
    return pathname.startsWith(href);
  }
  if (href === "/admin") {
    return pathname.startsWith("/admin") && !pathname.startsWith("/admin/configuration");
  }
  return pathname === href;
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

function Navigation({
  mobile = false,
  onNavigate,
  pathname,
  role,
}: {
  mobile?: boolean;
  onNavigate?: () => void;
  pathname: string;
  role: StaffRole;
}) {
  return (
    <nav aria-label="Navigazione area Staff" className="space-y-1">
      {buildStaffNavigation(role).map((item) => {
        const active = isStaffNavigationActive(pathname, item.href);
        return (
          <Link
            aria-current={active ? "page" : undefined}
            aria-label={item.label}
            className={`relative flex min-h-11 items-center gap-3 rounded-r-control px-4 text-sm font-medium text-shell-text transition-colors before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-transparent ${
              active
                ? "bg-shell-selected font-semibold before:bg-brand-copper"
                : "hover:bg-shell-hover"
            } ${mobile ? "" : "md:justify-center md:px-0 lg:justify-start lg:px-4"}`}
            data-nav-label={item.label}
            href={item.href}
            key={item.href}
            onClick={onNavigate}
            title={item.label}
          >
            <Icon name={item.icon} />
            <span className={mobile ? "" : "md:sr-only lg:not-sr-only"}>
              {item.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
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
  return (
    <div className="border-t border-white/15 pt-3">
      <div className={mobile ? "mb-3 px-4" : "mb-3 hidden px-4 lg:block"}>
        <p className="truncate text-sm font-semibold text-shell-text">{username}</p>
        <p className="mt-0.5 text-xs text-shell-text-secondary">
          {role === "ADMIN" ? "Amministratore" : "Staff"}
        </p>
      </div>
      <Link
        aria-label="Cambia password"
        className={`flex min-h-11 items-center gap-3 rounded-control px-4 text-sm font-medium text-shell-text-secondary hover:bg-shell-hover hover:text-shell-text ${
          mobile ? "" : "md:justify-center md:px-0 lg:justify-start lg:px-4"
        }`}
        href="/cambia-password"
        onClick={onNavigate}
        title="Cambia password"
      >
        <Icon name="key" />
        <span className={mobile ? "" : "md:sr-only lg:not-sr-only"}>Password</span>
      </Link>
      <form action="/api/auth/logout" method="post">
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
  const drawerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!drawerOpen) return;

    const previousOverflow = document.body.style.overflow;
    const menuButton = menuButtonRef.current;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      menuButton?.focus();
    };
  }, [drawerOpen]);

  function handleDrawerKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setDrawerOpen(false);
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = Array.from(
      drawerRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

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
        <div className="min-h-0 flex-1 px-2 lg:px-3">
          <Navigation pathname={pathname} role={role} />
        </div>
        <div className="p-2 pb-4 lg:p-3 lg:pb-5">
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
        <div className="fixed inset-0 z-[1100] md:hidden">
          <button
            aria-label="Chiudi navigazione"
            className="absolute inset-0 h-full w-full bg-black/55"
            onClick={() => setDrawerOpen(false)}
            tabIndex={-1}
            type="button"
          />
          <aside
            aria-label="Menu area Staff"
            aria-modal="true"
            className="absolute inset-y-0 left-0 flex w-[min(86vw,320px)] flex-col bg-shell p-4 shadow-2xl"
            id="staff-mobile-navigation"
            onKeyDown={handleDrawerKeyDown}
            ref={drawerRef}
            role="dialog"
          >
            <div className="flex min-h-14 items-center justify-between">
              <BrandLogo className="w-[124px]" />
              <button
                aria-label="Chiudi menu"
                className="inline-flex size-11 items-center justify-center rounded-control text-shell-text hover:bg-shell-hover"
                onClick={() => setDrawerOpen(false)}
                ref={closeButtonRef}
                type="button"
              >
                <Icon name="close" />
              </button>
            </div>
            <div className="mt-6 flex-1">
              <Navigation
                mobile
                onNavigate={() => setDrawerOpen(false)}
                pathname={pathname}
                role={role}
              />
            </div>
            <AccountActions
              mobile
              onNavigate={() => setDrawerOpen(false)}
              role={role}
              username={username}
            />
          </aside>
        </div>
      ) : null}

      <div
        className="min-w-0 md:ml-[72px] lg:ml-[216px]"
        id="staff-main-content"
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}
