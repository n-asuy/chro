
import { Button } from "@chro/ui/button";
import { Dialog, Transition } from "@headlessui/react";
import { X, ChevronRight, Loader2 } from "lucide-react";
import { Fragment, useState, useCallback, useEffect } from "react";
import { useLanguage } from "@/i18n";
import { BranchSelector, type GitBranch } from "./branch-selector";

export type RebaseDialogResult = {
  action: "confirmed" | "canceled";
  targetBranch?: string;
  upstreamBranch?: string;
};

type RebaseDialogProps = {
  open: boolean;
  onClose: () => void;
  isRebasing: boolean;
  branches: GitBranch[];
  isLoadingBranches?: boolean;
  initialTargetBranch?: string;
  initialUpstreamBranch?: string;
  onConfirm: (result: RebaseDialogResult) => void;
};

export function RebaseDialog({
  open,
  onClose,
  isRebasing,
  branches,
  isLoadingBranches = false,
  initialTargetBranch,
  initialUpstreamBranch,
  onConfirm,
}: RebaseDialogProps) {
  const { t } = useLanguage();
  const [targetBranch, setTargetBranch] = useState(initialTargetBranch ?? "");
  const [upstreamBranch, setUpstreamBranch] = useState(
    initialUpstreamBranch ?? "",
  );
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    if (initialTargetBranch) {
      setTargetBranch(initialTargetBranch);
    }
  }, [initialTargetBranch]);

  useEffect(() => {
    if (initialUpstreamBranch) {
      setUpstreamBranch(initialUpstreamBranch);
    }
  }, [initialUpstreamBranch]);

  useEffect(() => {
    if (!open) {
      setTargetBranch(initialTargetBranch ?? "");
      setUpstreamBranch(initialUpstreamBranch ?? "");
      setShowAdvanced(false);
    }
  }, [open, initialTargetBranch, initialUpstreamBranch]);

  const handleConfirm = useCallback(() => {
    const trimmedTarget = targetBranch.trim();
    if (!trimmedTarget) return;
    onConfirm({
      action: "confirmed",
      targetBranch: trimmedTarget,
      upstreamBranch: upstreamBranch.trim() || trimmedTarget,
    });
  }, [targetBranch, upstreamBranch, onConfirm]);

  const handleCancel = useCallback(() => {
    onConfirm({ action: "canceled" });
    onClose();
  }, [onConfirm, onClose]);

  const canConfirm = targetBranch.trim().length > 0 && !isRebasing;

  return (
    <Transition.Root show={open} as={Fragment}>
      <Dialog as="div" className="relative z-[90]" onClose={handleCancel}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-200"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-150"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black/50" />
        </Transition.Child>

        <div className="fixed inset-0 z-10 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-200"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-150"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <Dialog.Panel className="w-full max-w-md rounded-lg bg-background p-6 shadow-xl">
                <div className="flex items-center justify-between">
                  <Dialog.Title className="text-lg font-semibold text-foreground">
                    {t("rebaseDialogTitle")}
                  </Dialog.Title>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    onClick={handleCancel}
                    disabled={isRebasing}
                    aria-label={t("closeRebaseDialog")}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>

                <Dialog.Description className="mt-2 text-sm text-muted-foreground">
                  {t("rebaseDialogDescription")}
                </Dialog.Description>

                <div className="mt-4 space-y-4">
                  {/* Target branch selector */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-foreground">
                      {t("rebaseTargetLabel")}
                    </label>
                    {isLoadingBranches ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>{t("branchSelectorLoading")}</span>
                      </div>
                    ) : (
                      <BranchSelector
                        branches={branches}
                        selectedBranch={targetBranch || null}
                        onBranchSelect={setTargetBranch}
                        disabled={isRebasing}
                      />
                    )}
                  </div>

                  {/* Advanced section toggle */}
                  <div className="space-y-2">
                    <button
                      type="button"
                      onClick={() => setShowAdvanced((prev) => !prev)}
                      className="flex w-full items-center gap-2 text-left text-sm text-muted-foreground hover:text-foreground"
                    >
                      <ChevronRight
                        className={`h-3 w-3 ${showAdvanced ? "rotate-90" : ""}`}
                      />
                      <span>{t("rebaseAdvancedLabel")}</span>
                    </button>

                    {showAdvanced && (
                      <div className="space-y-2 pl-5">
                        <label className="text-sm font-medium text-foreground">
                          {t("rebaseUpstreamLabel")}
                        </label>
                        {isLoadingBranches ? (
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            <span>{t("branchSelectorLoading")}</span>
                          </div>
                        ) : (
                          <BranchSelector
                            branches={branches}
                            selectedBranch={upstreamBranch || null}
                            onBranchSelect={setUpstreamBranch}
                            disabled={isRebasing}
                          />
                        )}
                        <p className="text-xs text-muted-foreground">
                          {t("rebaseUpstreamHint")}
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="mt-6 flex justify-end gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleCancel}
                    disabled={isRebasing}
                  >
                    {t("cancelButtonLabel")}
                  </Button>
                  <Button
                    type="button"
                    onClick={handleConfirm}
                    disabled={!canConfirm}
                  >
                    {isRebasing ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        {t("rebaseInProgressLabel")}
                      </>
                    ) : (
                      t("rebaseConfirmLabel")
                    )}
                  </Button>
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition.Root>
  );
}
