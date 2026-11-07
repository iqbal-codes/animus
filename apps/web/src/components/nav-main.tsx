import type { ReactNode } from "react";
import { cn } from "cn";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

export type PrimaryNavItem<Id extends string = string> = {
  id: Id;
  title: string;
  icon: ReactNode;
  count?: number;
};

/**
 * Product navigation for the 64 px rail (`G08RJ`, `MDo3B`): 44 high rows at
 * an 8 px radius. The active row takes `$xai-surface` with `$xai-text`;
 * inactive rows keep the rail background and `$xai-text-secondary`. Each row
 * ends with a `<Badge / Count>` instance 22 high.
 */
export function NavMain<Id extends string>({
  items,
  activeId,
  onSelect,
  className,
}: {
  items: PrimaryNavItem<Id>[];
  activeId: Id | null;
  onSelect: (id: Id) => void;
  className?: string;
}) {
  return (
    <SidebarGroup className={cn("px-3", className)}>
      <SidebarMenu className="gap-2">
        {items.map((item) => {
          const active = item.id === activeId;
          return (
            <SidebarMenuItem key={item.id}>
              <SidebarMenuButton
                isActive={active}
                tooltip={item.title}
                aria-current={active ? "page" : undefined}
                onClick={() => onSelect(item.id)}
                className="h-11! gap-3! rounded-[var(--radius-news)]! px-3! text-sm text-text-secondary transition-colors [&_svg]:size-[18px] group-data-[collapsible=icon]:mx-auto"
              >
                {item.icon}
                <span className="truncate">{item.title}</span>
                {item.count !== undefined && (
                  <span className="ml-auto h-[22px] min-w-[22px] rounded-full bg-[var(--secondary)] px-[7px] text-center text-[11px] leading-[22px] tabular-nums group-data-[collapsible=icon]:hidden">
                    {item.count}
                  </span>
                )}
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
}
