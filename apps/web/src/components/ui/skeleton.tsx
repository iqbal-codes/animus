import { cn } from "cn";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-[var(--white-04)]", className)}
      {...props}
    />
  );
}

export { Skeleton };
