import { useState, type ComponentType, type ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";

/** Status tone used by every issue-detail molecule. */
export type DetailTone =
  | "neutral"
  | "secondary"
  | "muted"
  | "accent"
  | "success"
  | "warning"
  | "error"
  | "info";

export const TONE_TEXT: Record<DetailTone, string> = {
  neutral: "text-foreground",
  secondary: "text-[var(--text-secondary)]",
  muted: "text-[var(--text-muted)]",
  accent: "text-[var(--accent)]",
  success: "text-[var(--success)]",
  warning: "text-[var(--warning)]",
  error: "text-[var(--error)]",
  info: "text-[var(--info)]",
};

/**
 * Pill action chip used in the pinned header and section footers.
 * Source: `Animus / Issue detail / Expanded` — toolbar buttons.
 */
export function DetailButton({
  label,
  icon: Icon,
  tone = "secondary",
  onClick,
  href,
  ariaLabel,
  className,
}: {
  label: string;
  icon: LucideIcon;
  tone?: DetailTone;
  onClick?: () => void;
  href?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const body = (
    <>
      <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", TONE_TEXT[tone])} />
      <span className="text-xs leading-[1.5] text-foreground">{label}</span>
    </>
  );

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        aria-label={ariaLabel ?? label}
        className={cn(
          "inline-flex h-7 shrink-0 items-center gap-[7px] rounded-[7px] border border-[var(--border)] bg-[var(--surface)] px-2.5 py-0 text-xs transition-[color,background-color,border-color,scale] duration-150 ease-out hover:bg-[var(--white-04)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] active:scale-[0.96] motion-reduce:transform-none",
          className,
        )}
      >
        {body}
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel ?? label}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-[7px] rounded-[7px] border border-[var(--border)] bg-[var(--surface)] px-2.5 py-0 text-xs transition-[color,background-color,border-color,scale] duration-150 ease-out hover:bg-[var(--white-04)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] enabled:active:scale-[0.96] motion-reduce:transform-none",
        className,
      )}
    >
      {body}
    </button>
  );
}

/** Static pill button look-alike for non-interactive toolbar entries. */
export function DetailButtonShell({
  label,
  icon: Icon,
  tone = "secondary",
}: {
  label: string;
  icon: LucideIcon;
  tone?: DetailTone;
}) {
  return (
    <span className="inline-flex h-7 shrink-0 items-center gap-[7px] rounded-[7px] border border-[var(--border)] bg-[var(--surface)] px-2.5 py-0 text-xs">
      <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", TONE_TEXT[tone])} />
      <span className="text-xs leading-[1.5] text-foreground">{label}</span>
    </span>
  );
}

/** Solid primary pill action. */
export function DetailPrimaryButton({
  label,
  icon: Icon,
  onClick,
  disabled,
  tone = "neutral",
}: {
  label: string;
  icon?: LucideIcon;
  onClick?: () => void;
  disabled?: boolean;
  tone?: DetailTone;
}) {
  return (
    <Button
      size="sm"
      onClick={onClick}
      disabled={disabled}
      className="h-8 gap-[7px] rounded-[7px] bg-[var(--foreground)] px-[11px] py-0 text-xs font-normal text-[var(--background)] hover:bg-[var(--foreground)]/85"
    >
      {Icon && <Icon aria-hidden="true" className="size-3.5 shrink-0" />}
      <span className={cn("text-xs leading-[1.5]", tone === "neutral" ? "" : "")}>{label}</span>
    </Button>
  );
}

/** Secondary pill action used for the destructive/cancel path. */
export function DetailSecondaryButton({
  label,
  icon: Icon,
  onClick,
  disabled,
}: {
  label: string;
  icon?: LucideIcon;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      disabled={disabled}
      className="h-8 gap-[7px] rounded-[7px] border-[var(--border)] bg-[var(--surface)] px-[11px] py-0 text-xs font-normal text-foreground hover:bg-[var(--white-04)]"
    >
      {Icon && <Icon aria-hidden="true" className="size-3.5 shrink-0" />}
      <span className="text-xs leading-[1.5]">{label}</span>
    </Button>
  );
}

/** Solid/soft status pill (`Implement`, `Running`, `Live`). */
export function StatusPill({
  label,
  tone = "muted",
  soft = false,
}: {
  label: string;
  tone?: DetailTone;
  soft?: boolean;
}) {
  const fill =
    soft && tone === "accent"
      ? "bg-[var(--accent-bg)]"
      : soft && tone === "success"
        ? "bg-[var(--success-bg)]"
        : soft && tone === "warning"
          ? "bg-[var(--warning-bg)]"
          : soft && tone === "error"
            ? "bg-[var(--error-bg)]"
            : "bg-[var(--white-04)]";

  return (
    <span
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-[5px] rounded-[7px] px-2.5 text-[11px] leading-[14px] font-medium whitespace-nowrap",
        fill,
      )}
    >
      <span className={TONE_TEXT[tone]}>{label}</span>
    </span>
  );
}

/** Monospace metadata line (timestamps, counts, identifiers). */
export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("font-mono text-[11px] leading-[1.5] text-[var(--text-muted)]", className)}>
      {children}
    </span>
  );
}

/**
 * Hairline-divided section. Every inspector/rail block in the source design is a
 * flat vertical block separated by a 1px bottom border — never a nested card.
 */
export function DetailSection({
  label,
  children,
  divided = true,
  padTop = 18,
  padBottom = 18,
  className,
  action,
}: {
  label?: string;
  children: ReactNode;
  divided?: boolean;
  padTop?: number;
  padBottom?: number;
  className?: string;
  action?: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className={cn(
        "flex w-full flex-col",
        divided && "border-b border-[var(--border-subtle)]",
        className,
      )}
      style={{ paddingTop: padTop, paddingBottom: padBottom }}
    >
      {children}
      {action}
    </section>
  );
}

/** Disclosure row with leading chevron and a trailing summary. */
export function DisclosureRow({
  label,
  summary,
  divided = true,
  defaultOpen = false,
  children,
}: {
  label: string;
  summary?: string;
  divided?: boolean;
  defaultOpen?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={cn(divided && "border-b border-[var(--border-subtle)]")}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="flex w-full items-center gap-[10px] py-[18px] text-left transition-[color,background-color] duration-150 ease-out hover:bg-[var(--white-04)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-[var(--text-muted)] transition-transform duration-150 ease-out motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        <span className="text-xs leading-[1.5] text-foreground">{label}</span>
        <span className="flex-1" />
        {summary && (
          <span className="text-[11px] leading-[1.5] text-[var(--text-muted)]">{summary}</span>
        )}
      </button>
      {open && children && <div className="flex flex-col gap-2.5 pt-0.5 pb-3.5">{children}</div>}
    </div>
  );
}

/** Label / value row used by the job-context block. */
export function KeyValueRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-[10px]">
      <span className="text-[11px] leading-[1.5] text-[var(--text-muted)]">{label}</span>
      <span className="flex-1" />
      <span className="font-mono text-[11px] leading-[1.5] text-[var(--text-secondary)]">
        {value}
      </span>
    </div>
  );
}

/** Small section heading used inside disclosure blocks. */
export function FieldLabel({ children }: { children: ReactNode }) {
  return <span className="text-[11px] leading-[1.5] text-[var(--text-muted)]">{children}</span>;
}

/** Body copy at the source's 13 px inspector size. */
export function BodyText({ children }: { children: ReactNode }) {
  return (
    <p className="whitespace-pre-line text-[13px] leading-[1.5] text-[var(--text-secondary)]">
      {children}
    </p>
  );
}

export type ComparisonColumn = { before: string; after: string };

/** Before/after evidence table with the source's 112 px label column. */
export function ComparisonTable({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ label: string; before: string; after: string }>;
}) {
  if (rows.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs leading-[1.5] font-medium text-foreground">{title}</span>
      <div className="w-full overflow-hidden rounded-[6px] border border-[var(--border-subtle)]">
        <div className="flex h-[30px] w-full border-b border-[var(--border-subtle)] bg-[var(--white-04)]">
          <div className="flex w-[112px] min-w-0 shrink-0 items-center border-r border-[var(--border-subtle)] px-3">
            <span className="min-w-0 break-words text-[11px] leading-[1.5] font-medium text-[var(--text-secondary)]">
              Check
            </span>
          </div>
          <div className="flex min-w-0 flex-1 items-center border-r border-[var(--border-subtle)] px-3">
            <span className="min-w-0 break-words text-[11px] leading-[1.5] font-medium text-[var(--text-secondary)]">
              Kind
            </span>
          </div>
          <div className="flex min-w-0 flex-1 items-center px-3">
            <span className="min-w-0 break-words text-[11px] leading-[1.5] font-medium text-[var(--accent)]">
              Result
            </span>
          </div>
        </div>
        {rows.map((row, index) => (
          <div
            key={`${row.label}-${index}`}
            className={cn(
              "flex w-full",
              index < rows.length - 1 && "border-b border-[var(--border-subtle)]",
            )}
          >
            <div className="flex w-[112px] min-w-0 shrink-0 items-center border-r border-[var(--border-subtle)] px-3 py-3">
              <span className="min-w-0 break-words text-[11px] leading-[1.5] text-[var(--text-secondary)]">
                {row.label}
              </span>
            </div>
            <div className="flex min-w-0 flex-1 items-center border-r border-[var(--border-subtle)] px-3 py-3">
              <span className="min-w-0 break-words text-xs leading-[1.5] text-[var(--text-secondary)]">
                {row.before}
              </span>
            </div>
            <div className="flex min-w-0 flex-1 items-center px-3 py-3">
              <span className="min-w-0 break-words text-xs leading-[1.5] text-[var(--accent)]">
                {row.after}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export type { ComponentType };
