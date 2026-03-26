
import {
  Archive,
  BarChart3,
  Ellipsis,
  FileText,
  LayoutGrid,
  LineChart,
} from "lucide-react";
import { SidebarNavItem } from "./sidebar-nav-item";
import { SidebarSection } from "./sidebar-section";

const workspaceItems = [
  { id: "projects", label: "Projects", icon: LayoutGrid },
  { id: "views", label: "Workspace views", icon: LineChart },
  { id: "analytics", label: "Analytics", icon: BarChart3 },
  { id: "drafts", label: "Drafts", icon: FileText },
  { id: "archives", label: "Archives", icon: Archive },
];

export const SidebarMenuItems = () => (
  <>
    <SidebarSection title="Workspace">
      {workspaceItems.map((item) => {
        const Icon = item.icon;
        return (
          <SidebarNavItem key={item.id}>
            <div className="flex items-center gap-1.5 py-[1px]">
              <Icon className="flex-shrink-0 size-3.5" strokeWidth={1.5} />
              <span className="font-workspace text-[12px] leading-[1.35]">
                {item.label}
              </span>
            </div>
          </SidebarNavItem>
        );
      })}

      <SidebarNavItem>
        <button
          type="button"
          className="font-workspace text-[12px] leading-[1.35] flex items-center gap-1.5 flex-grow text-custom-sidebar-text-300"
          id="extended-sidebar-toggle"
        >
          <Ellipsis className="flex-shrink-0 size-4" />
          <span className="font-workspace text-[12px] leading-[1.35]">
            More
          </span>
        </button>
      </SidebarNavItem>
    </SidebarSection>
  </>
);
