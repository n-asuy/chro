import { WorkspaceOpenDialog } from "@/components/dialogs/workspace-open-dialog";
import { prepareWorkspace } from "@/lib/open-workspace";
import { isUiStateReady } from "@/lib/ui-state-client";
import { getRecentWorkspaces } from "@/lib/workspace-history";
import { Button } from "@chro/ui/button";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { FolderOpen, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/")({
  component: HomePage,
});

type Phase = "resolving" | "empty";

/**
 * Boot entry. The app launches straight into the main (session-sized) window;
 * this route resolves which workspace to open rather than showing a dedicated
 * picker screen:
 *
 *   - returning user → auto-open the most recent workspace
 *   - first launch (no history) → a minimal "open a folder" prompt that opens
 *     the in-app folder browser (which flags git repos)
 *
 * The git/agent setup screen is no longer a route — it floats above everything
 * as `<OnboardingFlow />` (see `routes/__root.tsx`).
 */
function HomePage() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("resolving");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const resolve = () => {
      if (cancelled) return;
      // Recent workspaces live in persisted UI state, which hydrates after
      // first paint. Wait for it so a returning user isn't shown the empty
      // state before their history loads.
      if (!isUiStateReady()) {
        timer = setTimeout(resolve, 50);
        return;
      }

      const recents = getRecentWorkspaces();
      if (recents.length === 0) {
        setPhase("empty");
        return;
      }

      void prepareWorkspace(recents[0].path)
        .then((landing) => {
          if (!cancelled) navigate({ to: landing });
        })
        .catch((err) => {
          console.error("[home] Failed to open recent workspace", err);
          if (!cancelled) {
            setErrorMessage(
              "Couldn't reopen your last workspace. Open a folder to continue.",
            );
            setPhase("empty");
          }
        });
    };

    resolve();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [navigate]);

  if (phase === "resolving") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <div className="flex w-full max-w-sm flex-col items-center gap-8">
        <img
          src="/logo_chro_symbol.png"
          alt="Chro"
          width={48}
          height={48}
          className="size-12"
        />
        <div className="space-y-1.5 text-center">
          <h1 className="text-base font-medium">Open a workspace</h1>
          <p className="text-sm text-muted-foreground">
            Choose a folder to start working in Chro.
          </p>
        </div>

        <Button
          size="lg"
          className="w-full gap-2"
          onClick={() => setPickerOpen(true)}
        >
          <FolderOpen className="size-4" />
          Open folder
        </Button>

        {errorMessage ? (
          <p className="w-full rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-center text-xs text-destructive">
            {errorMessage}
          </p>
        ) : null}
      </div>

      <WorkspaceOpenDialog open={pickerOpen} onOpenChange={setPickerOpen} />
    </div>
  );
}
