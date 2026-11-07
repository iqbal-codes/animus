import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

const alertVariants = cva(
  "group/alert relative grid w-full gap-4 rounded-[var(--radius-news)] border border-[var(--border-subtle)] bg-[var(--surface)] p-5 text-left text-sm text-foreground has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-16 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-4 *:[svg]:row-span-2 *:[svg]:translate-y-0 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-5",
  {
    variants: {
      variant: {
        default: "",
        info: "[&>svg]:text-[var(--info)]",
        success: "[&>svg]:text-[var(--success)]",
        warning: "[&>svg]:text-[var(--warning)]",
        error: "[&>svg]:text-[var(--error)]",
        destructive: "[&>svg]:text-[var(--error)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "text-sm leading-[1.5] text-balance text-[var(--text-secondary)] md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
        className,
      )}
      {...props}
    />
  );
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="alert-action" className={cn("absolute top-5 right-5", className)} {...props} />
  );
}

export { Alert, AlertTitle, AlertDescription, AlertAction };
