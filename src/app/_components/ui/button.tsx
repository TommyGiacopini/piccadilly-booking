import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "primary" | "secondary" | "secondaryInverse" | "quiet";

export function buttonClassName(
  variant: ButtonVariant = "primary",
  fullWidth = false,
): string {
  const base =
    "inline-flex min-h-11 items-center justify-center rounded-control px-5 py-2.5 text-sm font-semibold transition-colors disabled:cursor-wait disabled:opacity-60";
  const variants: Record<ButtonVariant, string> = {
    primary:
      "border border-brand-primary bg-brand-primary text-brand-on-primary hover:border-brand-primary-hover hover:bg-brand-primary-hover active:border-brand-primary-active active:bg-brand-primary-active",
    secondary:
      "border border-border-strong bg-surface text-text-primary hover:border-brand-primary hover:text-brand-primary",
    secondaryInverse:
      "border border-shell-text-secondary bg-transparent text-shell-text hover:border-white hover:bg-shell-hover hover:text-white",
    quiet:
      "border border-transparent bg-transparent text-text-secondary hover:bg-surface-muted hover:text-text-primary",
  };
  return `${base} ${variants[variant]} ${fullWidth ? "w-full" : ""}`;
}

export function Button({
  children,
  className = "",
  fullWidth = false,
  variant = "primary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  fullWidth?: boolean;
  variant?: ButtonVariant;
}) {
  return (
    <button
      className={`${buttonClassName(variant, fullWidth)} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function ButtonLink({
  children,
  className = "",
  fullWidth = false,
  href,
  variant = "primary",
}: {
  children: ReactNode;
  className?: string;
  fullWidth?: boolean;
  href: string;
  variant?: ButtonVariant;
}) {
  return (
    <Link
      className={`${buttonClassName(variant, fullWidth)} ${className}`}
      href={href}
    >
      {children}
    </Link>
  );
}
