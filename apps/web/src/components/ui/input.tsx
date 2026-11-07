import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "cn";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-12 w-full min-w-0 rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--surface)] px-4 py-3 text-sm leading-[1.5] transition-colors outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-[var(--text-secondary)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-[var(--border-subtle)] disabled:bg-secondary disabled:text-[var(--text-secondary)] disabled:opacity-100 aria-invalid:border-[var(--error)]",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
