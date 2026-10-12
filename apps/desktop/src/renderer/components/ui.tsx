import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { RelayState } from "../../shared/api";

export function Button({
  variant = "secondary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  const styles = {
    primary: "bg-neutral-900 text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200",
    secondary:
      "bg-white text-neutral-800 ring-1 ring-black/10 hover:bg-neutral-50 dark:bg-white/5 dark:text-neutral-100 dark:ring-white/10 dark:hover:bg-white/10",
    ghost: "text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/10",
    danger: "text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10",
  }[variant];
  return (
    <button
      className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors duration-150 disabled:opacity-40 ${styles} ${className}`}
      {...props}
    />
  );
}

export function StatusDot({ state }: { state: RelayState | "running" | "idle" | "ended" | "starting" }) {
  const color = {
    online: "bg-emerald-500 text-emerald-500 animate-pulse-dot",
    running: "bg-emerald-500 text-emerald-500 animate-pulse-dot",
    idle: "bg-sky-500",
    connecting: "bg-amber-500",
    starting: "bg-amber-500",
    offline: "bg-neutral-400",
    ended: "bg-neutral-300 dark:bg-neutral-600",
  }[state];
  return <span className={`inline-block size-2 shrink-0 rounded-full ${color}`} />;
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="drag flex h-14 shrink-0 items-center justify-between border-b border-black/5 px-6 dark:border-white/5">
      <div>
        <h1 className="text-[15px] font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-xs text-neutral-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="animate-fade-in flex flex-col items-center px-8 py-16 text-center">
      <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-black/5 text-neutral-500 dark:bg-white/5">{icon}</div>
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-1 max-w-xs text-xs leading-relaxed text-neutral-500">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Row({ icon, title, subtitle, trailing }: { icon: ReactNode; title: ReactNode; subtitle?: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="group flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors duration-150 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-black/5 text-neutral-600 dark:bg-white/5 dark:text-neutral-300">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{title}</div>
        {subtitle && <div className="truncate text-xs text-neutral-500">{subtitle}</div>}
      </div>
      {trailing && <div className="flex shrink-0 items-center gap-1">{trailing}</div>}
    </div>
  );
}

export function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
