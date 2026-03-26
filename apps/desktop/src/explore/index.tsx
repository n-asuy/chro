import { ProjectProvider } from "@/files/context/project-context";
import { useLanguage } from "@/i18n";
import { AppRail } from "@/sidebar/app-rail";
import { AppRailProvider } from "@/sidebar/app-rail-context";
import { ElectronTitlebar } from "@/window/electron-titlebar";
import { RefreshCw } from "lucide-react";
import { GraphView } from "./components/graph-view";
import { useGraphData } from "./hooks/use-graph-data";

interface ExploreLayoutProps {
  projectId: string;
}

export default function ExploreLayout({ projectId }: ExploreLayoutProps) {
  const { graphData, loading, error, reload } = useGraphData(projectId);
  const { t } = useLanguage();

  let content: React.ReactNode;

  if (error) {
    content = (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-sm text-red-400 mb-3">{error}</p>
          <button
            type="button"
            onClick={() => void reload()}
            className="inline-flex items-center gap-1.5 text-sm text-custom-text-300 hover:text-custom-text-100"
          >
            <RefreshCw size={14} />
            {t("exploreReload")}
          </button>
        </div>
      </div>
    );
  } else if (loading && !graphData) {
    content = (
      <div className="flex-1 flex items-center justify-center">
        <span className="text-sm text-custom-text-400">
          {t("exploreLoading")}
        </span>
      </div>
    );
  } else if (!graphData || graphData.nodes.length === 0) {
    content = (
      <div className="flex-1 flex items-center justify-center">
        <span className="text-sm text-custom-text-400">
          {t("exploreEmpty")}
        </span>
      </div>
    );
  } else {
    content = <GraphView graphData={graphData} />;
  }

  return (
    <AppRailProvider>
      <ProjectProvider>
        <div className="flex h-screen w-full bg-custom-background-90 text-foreground font-sans antialiased overflow-hidden selection:bg-custom-primary-100/20 selection:text-custom-primary-100">
          <ElectronTitlebar />
          <AppRail />

          <div className="relative flex h-full min-h-0 flex-1 flex-col">
            <div className="relative z-10 mr-2 mb-2 ml-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-custom-border-200 bg-custom-background-100">
              {content}
            </div>
          </div>
        </div>
      </ProjectProvider>
    </AppRailProvider>
  );
}
