import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

const badgeVariants = cva(
  "group/badge inline-flex h-6 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2.5 text-[11px] leading-none font-medium whitespace-nowrap transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-[var(--surface)] text-[var(--text-secondary)]",
        secondary: "bg-secondary text-secondary-foreground",
        outline: "border-[var(--input)] bg-transparent text-[var(--text-secondary)]",
        success: "bg-[var(--surface)] text-[var(--success)]",
        warning: "bg-[var(--surface)] text-[var(--warning)]",
        error: "bg-[var(--surface)] text-[var(--error)]",
        accent: "bg-[var(--accent-bg)] text-[var(--accent)]",
        count: "bg-[var(--surface)] px-[7px] text-foreground",
        muted: "bg-[var(--surface)] text-[var(--text-muted)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props,
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  });
}

export { Badge, badgeVariants };
