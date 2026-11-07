import * as React from "react";
import { cn } from "cn";
import { ChevronDownIcon } from "lucide-react";

type NativeSelectProps = Omit<React.ComponentProps<"select">, "size"> & {
  size?: "sm" | "default";
};

function NativeSelect({ className, size = "default", ...props }: NativeSelectProps) {
  return (
    <div
      className={cn(
        "group/native-select relative w-fit has-[select:disabled]:opacity-50",
        className,
      )}
      data-slot="native-select-wrapper"
      data-size={size}
    >
      <select
        data-slot="native-select"
        data-size={size}
        className="h-12 w-full min-w-0 appearance-none rounded-[var(--radius-news)] border border-[var(--input)] bg-[var(--surface)] py-3 pr-10 pl-4 text-sm leading-[1.5] transition-colors outline-none select-none selection:bg-primary selection:text-primary-foreground placeholder:text-[var(--text-secondary)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-[var(--border-subtle)] disabled:bg-secondary disabled:text-[var(--text-secondary)] disabled:opacity-100 data-[size=sm]:h-9 data-[size=sm]:rounded-[var(--radius-news)] data-[size=sm]:py-2 aria-invalid:border-[var(--error)]"
        {...props}
      />
      <ChevronDownIcon
        className="pointer-events-none absolute top-1/2 right-4 size-4 -translate-y-1/2 text-[var(--text-secondary)] select-none"
        aria-hidden="true"
        data-slot="native-select-icon"
      />
    </div>
  );
}

function NativeSelectOption({ className, ...props }: React.ComponentProps<"option">) {
  return (
    <option
      data-slot="native-select-option"
      className={cn("bg-[Canvas] text-[CanvasText]", className)}
      {...props}
    />
  );
}

function NativeSelectOptGroup({ className, ...props }: React.ComponentProps<"optgroup">) {
  return (
    <optgroup
      data-slot="native-select-optgroup"
      className={cn("bg-[Canvas] text-[CanvasText]", className)}
      {...props}
    />
  );
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption };
