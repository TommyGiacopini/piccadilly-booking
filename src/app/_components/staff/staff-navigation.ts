export type StaffRole = "ADMIN" | "STAFF";
export type NavigationIcon = "agenda" | "add" | "settings" | "admin";
export type NavigationGroupId = "operations" | "configuration" | "communication" | "administration";

export interface StaffNavigationItem {
  readonly href: string;
  readonly icon: NavigationIcon;
  readonly label: string;
}

export interface StaffNavigationGroup {
  readonly id: NavigationGroupId;
  readonly label: string;
  readonly roles: readonly StaffRole[];
  readonly items: readonly StaffNavigationItem[];
}

// Presentation metadata only. Server guards remain the authorization boundary.
export const staffNavigationGroups: readonly StaffNavigationGroup[] = [
  { id: "operations", label: "Operatività", roles: ["STAFF", "ADMIN"], items: [
    { href: "/dashboard", icon: "agenda", label: "Agenda" },
    { href: "/dashboard/reservations/new", icon: "add", label: "Nuova prenotazione" },
    { href: "/dashboard/assign-room", icon: "add", label: "ASSEGNA SALA" },
  ] },
  { id: "configuration", label: "Configurazione", roles: ["ADMIN"], items: [
    { href: "/admin/configuration", icon: "settings", label: "Impostazioni operative" },
    { href: "/admin/schedules", icon: "settings", label: "Orari settimanali" },
    { href: "/admin/special-dates", icon: "settings", label: "Date speciali" },
    { href: "/admin/rooms", icon: "settings", label: "Sale" },
    { href: "/admin/availability-preview", icon: "settings", label: "Anteprima disponibilità" },
  ] },
  { id: "communication", label: "Comunicazione", roles: ["ADMIN"], items: [
    { href: "/admin/public-settings", icon: "settings", label: "Contenuti pubblici IT/EN" },
    { href: "/admin/notification-settings", icon: "settings", label: "Notifiche" },
  ] },
  { id: "administration", label: "Amministrazione", roles: ["ADMIN"], items: [
    { href: "/admin/users", icon: "admin", label: "Gestione utenti" },
    { href: "/admin/audit", icon: "admin", label: "Registro audit" },
  ] },
];

export const adminHub: StaffNavigationItem = { href: "/admin", icon: "admin", label: "Admin" };

export function navigationGroupsForRole(role: StaffRole): readonly StaffNavigationGroup[] {
  return staffNavigationGroups.filter(group => group.roles.includes(role));
}

export function buildStaffNavigation(role: StaffRole): StaffNavigationItem[] {
  return [...navigationGroupsForRole(role).flatMap(group => group.items), ...(role === "ADMIN" ? [adminHub] : [])];
}

function pathOnly(pathname: string): string {
  return pathname.split(/[?#]/u, 1)[0].replace(/\/+$/u, "") || "/";
}

function within(path: string, base: string): boolean {
  return path === base || path.startsWith(base + "/");
}

export function isStaffNavigationActive(pathname: string, href: string): boolean {
  const path = pathOnly(pathname);
  if (href === "/admin") return path === href;
  if (href === "/dashboard") {
    return within(path, href) && !within(path, "/dashboard/reservations/new") && !within(path, "/dashboard/assign-room");
  }
  return within(path, href);
}

export function navigationGroupForPath(pathname: string): StaffNavigationGroup | undefined {
  return staffNavigationGroups.find(group => group.items.some(item => isStaffNavigationActive(pathname, item.href)));
}

export interface StaffBreadcrumb { readonly label: string; readonly href?: string }

export function staffBreadcrumbs(pathname: string, role: StaffRole): readonly StaffBreadcrumb[] {
  const path = pathOnly(pathname);
  if (path === "/admin") return role === "ADMIN" ? [{ label: "Hub Admin" }] : [];
  const group = navigationGroupsForRole(role).find(candidate => candidate.items.some(item => isStaffNavigationActive(path, item.href)));
  if (!group) return [];
  const item = group.items.find(candidate => isStaffNavigationActive(path, candidate.href))!;
  if (group.id !== "operations") return [{ label: "Hub Admin", href: adminHub.href }, { label: group.label }, { label: item.label }];
  const resource = /^\/dashboard\/reservations\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(\/edit)?$/iu.exec(path);
  if (resource) return [{ label: "Agenda", href: "/dashboard" }, { label: "Dettaglio prenotazione", ...(resource[2] ? { href: "/dashboard/reservations/" + resource[1] } : {}) }, ...(resource[2] ? [{ label: "Modifica" }] : [])];
  return [{ label: group.label }, { label: item.label }];
}
