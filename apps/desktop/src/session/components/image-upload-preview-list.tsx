import { Button } from "@chro/ui/button";
import { AlertCircle, Loader2, X } from "lucide-react";
import type { TranslationKey } from "@/i18n";
import type { ImageUploadItem } from "../hooks/use-image-uploads";

interface ImageUploadPreviewListProps {
  items: ImageUploadItem[];
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  onRetryUpload: (clientId: string) => void;
  onRemoveUpload: (clientId: string) => void;
  className?: string;
}

export const ImageUploadPreviewList = ({
  items,
  t,
  onRetryUpload,
  onRemoveUpload,
  className,
}: ImageUploadPreviewListProps) => {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className={className ?? "w-full"}>
      <div className="flex flex-wrap gap-2">
        {items.map((item) => (
          <div
            key={item.clientId}
            className="relative flex w-28 min-w-[7rem] flex-col overflow-hidden rounded border border-border/50 bg-background"
          >
            <img
              src={item.previewUrl}
              alt={item.name}
              width={112}
              height={80}
              loading="lazy"
              decoding="async"
              className="h-20 w-full object-cover"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1 h-5 w-5 bg-background/70 text-muted-foreground hover:bg-background"
              onClick={() => onRemoveUpload(item.clientId)}
            >
              <span className="sr-only">{t("uploadsRemoveButton")}</span>
              <X className="h-3 w-3" />
            </Button>
            <div className="space-y-1 px-2 py-1 text-left text-[10px]">
              <p className="truncate font-medium text-foreground">
                {item.name}
              </p>
              {item.status === "uploading" ? (
                <p className="text-[11px] text-muted-foreground">
                  {t("uploadsUploadingStatus")}
                </p>
              ) : null}
              {item.status === "error" ? (
                <div className="space-y-1 text-[11px] text-destructive">
                  <div className="flex items-center gap-1">
                    <AlertCircle className="h-3 w-3" />
                    <span>{t("uploadsFailedStatus")}</span>
                  </div>
                  {item.error ? <p>{item.error}</p> : null}
                </div>
              ) : null}
            </div>
            {item.status === "error" ? (
              <div className="flex gap-2 px-2 pb-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => onRetryUpload(item.clientId)}
                >
                  {t("uploadsRetryButton")}
                </Button>
              </div>
            ) : null}
            {item.status === "uploading" ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/50">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
};
