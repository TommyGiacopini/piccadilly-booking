import type { ReactNode } from "react";

export function Alert({
  children,
  tone = "danger",
}: {
  children: ReactNode;
  tone?: "danger" | "success" | "warning";
}) {
  const styles = {
    danger: "border-danger/30 bg-danger/8 text-danger",
    success: "border-success/30 bg-success/8 text-success",
    warning: "border-warning/30 bg-warning/8 text-warning",
  } as const;

  return (
    <div
      className={`rounded-surface border px-4 py-3 text-sm font-medium ${styles[tone]}`}
      role={tone === "danger" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}
