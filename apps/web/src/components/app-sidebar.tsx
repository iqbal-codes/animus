import { Columns3, Inbox, PanelLeftClose, Settings } from "lucide-react";
import { useSidebar } from "@/components/ui/sidebar";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { NavMain, type PrimaryNavItem } from "@/components/nav-main";

export type NavId = "inbox" | "jobs";

/**
 * The Animus shell rail, expanded (`EeR9s`) and collapsed (`G08RJ`): Inbox and
 * Jobs above, Settings pinned to the bottom. Settings is not a destination — it
 * opens the `R5yIDY` modal over the current surface.
 */
export function AppSidebar({
  activeId,
  onSelect,
  jobCount,
  inboxCount,
  settingsOpen,
  onOpenSettings,
}: {
  activeId: NavId;
  onSelect: (id: NavId) => void;
  jobCount: number;
  inboxCount?: number;
  settingsOpen: boolean;
  onOpenSettings: () => void;
}) {
  const { toggleSidebar } = useSidebar();

  const items: PrimaryNavItem<NavId>[] = [
    { id: "inbox", title: "Inbox", icon: <Inbox />, count: inboxCount },
    { id: "jobs", title: "Jobs", icon: <Columns3 />, count: jobCount },
  ];

  return (
    <Sidebar collapsible="icon" className="border-r border-[var(--border-subtle)]">
      <SidebarHeader className="flex-row items-center px-3 pt-5 pb-0">
        <div className="flex h-9 w-full items-center gap-2.5 px-2 transition-transform duration-150 ease-out motion-reduce:transition-none group-data-[collapsible=icon]:-translate-x-[2.5px] group-data-[collapsible=icon]:pr-0">
          <img
            src="/brand/animus-emblem.webp"
            alt=""
            width={28}
            height={28}
            className="size-7 shrink-0 rounded-[7px] object-cover outline outline-1 -outline-offset-1 outline-white/10"
          />
          <span className="truncate text-[22px] leading-[1.4] font-semibold tracking-[-0.7px] group-data-[collapsible=icon]:hidden">
            animus
          </span>
          <span className="flex-1 group-data-[collapsible=icon]:hidden" />
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
            className="shrink-0 text-text-secondary transition-colors hover:text-foreground group-data-[collapsible=icon]:hidden"
          >
            <PanelLeftClose aria-hidden="true" className="size-[18px]" />
          </button>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <NavMain items={items} activeId={activeId} onSelect={onSelect} className="pt-5" />
      </SidebarContent>

      <SidebarFooter className="px-3 pb-4">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={settingsOpen}
              tooltip="Settings"
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
              data-settings-trigger=""
              onClick={onOpenSettings}
              className="h-11! gap-3! rounded-[var(--radius-news)]! px-3! text-sm text-text-secondary transition-colors [&_svg]:size-[18px] group-data-[collapsible=icon]:mx-auto"
            >
              <Settings aria-hidden="true" />
              <span className="truncate">Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
