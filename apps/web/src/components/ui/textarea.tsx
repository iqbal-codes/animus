import * as React from "react";
import { cn } from "cn";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-32 w-full rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--surface)] p-4 text-sm leading-[1.5] transition-colors outline-none placeholder:text-[var(--text-secondary)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:border-[var(--border-subtle)] disabled:bg-secondary disabled:text-[var(--text-secondary)] disabled:opacity-100 aria-invalid:border-[var(--error)]",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
