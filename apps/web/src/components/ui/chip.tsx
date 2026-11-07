import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

const chipVariants = cva(
  "group/chip inline-flex h-8 shrink-0 items-center gap-2 rounded-full border px-3 text-[13px] leading-[1.5] font-normal whitespace-nowrap transition-colors outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border-[var(--border)] bg-[var(--surface)] text-foreground hover:bg-[color-mix(in_oklch,var(--surface),var(--foreground)_5%)]",
        selected: "border-transparent bg-primary text-primary-foreground hover:bg-primary/80",
        ghost:
          "border-transparent bg-transparent text-[var(--text-secondary)] hover:bg-[var(--white-04)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Chip({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof chipVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(chipVariants({ variant }), className),
      },
      props,
    ),
    render,
    state: {
      slot: "chip",
      variant,
    },
  });
}

function ChipAction({ className, type = "button", ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type={type}
      data-slot="chip-action"
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-full text-current opacity-70 transition-opacity outline-none hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-current disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

export { Chip, ChipAction, chipVariants };
