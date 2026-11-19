import {
  type SupportedLanguage,
  type TranslationFunction,
  useLanguage,
} from "@/i18n";
import { cn } from "@/lib/cn";
import { Alert, AlertDescription, AlertTitle } from "@chro/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@chro/ui/alert-dialog";
import { Button } from "@chro/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@chro/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@chro/ui/dropdown-menu";
import { Input } from "@chro/ui/input";
import { Label } from "@chro/ui/label";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  Loader2,
  Plus,
  QrCode,
  RefreshCcw,
  Smartphone,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import { SettingsRow } from "../components/settings-row";
import { SettingsSection } from "../components/settings-section";
import { useMobilePairing } from "../hooks/use-mobile-pairing";
import {
  type MobilePairingApi,
  type NetworkAddress,
  type PairedDevice,
  type PairingOffer,
  endpointPort,
  mobilePairingApi,
} from "../lib/mobile-pairing-client";

const COPY_CONFIRMATION_MS = 2_000;

const DATE_LOCALES: Record<SupportedLanguage, string> = {
  en: "en-US",
  ja: "ja-JP",
};

type MobilePaneProps = {
  api?: MobilePairingApi;
  /** Host OS as reported by the runtime (`darwin`, `win32`, `linux`). */
  platform?: string;
};

const runtimePlatform = (): string | undefined =>
  typeof window === "undefined" ? undefined : window.__CHRO_RUNTIME__?.platform;

const addressLabel = (entry: NetworkAddress) =>
  `${entry.address} (${entry.label})`;

const qrDataUrl = (svg: string) =>
  `data:image/svg+xml,${encodeURIComponent(svg)}`;

export function MobilePane({
  api = mobilePairingApi,
  platform = runtimePlatform(),
}: MobilePaneProps) {
  const { t, language } = useLanguage();
  const pairing = useMobilePairing(api);
  const { offer, expired } = pairing;
  const current = offer.current;

  return (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="font-workspace text-[20px] font-bold text-foreground">
          {t("mobileSettingsTitle")}
        </h2>
        <p className="font-workspace text-[13px] text-muted-foreground mt-1">
          {t("mobileSettingsDescription")}
        </p>
      </div>

      <SettingsSection
        heading={t("mobilePairTitle")}
        description={t("mobilePairDescription")}
      >
        <AddressRow
          t={t}
          pairing={pairing}
          onRefresh={() => void pairing.reloadInterfaces()}
        />
        <div className="flex flex-col gap-3 px-5 py-4">
          <div>
            <Button
              type="button"
              size="sm"
              onClick={pairing.generate}
              disabled={!pairing.selectedAddress || offer.generating}
              className="font-workspace gap-1.5 text-[13px]"
            >
              {offer.generating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : current ? (
                <RefreshCcw className="h-3.5 w-3.5" />
              ) : (
                <QrCode className="h-3.5 w-3.5" />
              )}
              {current ? t("mobileRegenerate") : t("mobileGenerate")}
            </Button>
          </div>
          {offer.error ? (
            <Alert
              variant="destructive"
              className="border-destructive/30 bg-destructive/10"
            >
              <AlertTitle>{t("mobileOfferError")}</AlertTitle>
              <AlertDescription>{offer.error}</AlertDescription>
            </Alert>
          ) : null}
          {current ? (
            <OfferView t={t} offer={current} expired={expired} />
          ) : null}
        </div>
      </SettingsSection>

      {platform === "win32" ? (
        <Alert className="border-amber-300/60 bg-amber-50 text-amber-900">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t("mobileFirewallTitle")}</AlertTitle>
          <AlertDescription>
            <FirewallDescription t={t} offer={current} />
          </AlertDescription>
        </Alert>
      ) : null}

      <SettingsSection
        heading={t("mobileDevicesTitle")}
        description={t("mobileDevicesDescription")}
      >
        <DevicesList
          t={t}
          language={language}
          devices={pairing.devices}
          codeOnScreen={current !== null && !expired}
          onRetry={() => void pairing.reloadDevices()}
          onRevoke={pairing.requestRevoke}
        />
        {pairing.revoke.error ? (
          <div className="px-5 py-4">
            <Alert
              variant="destructive"
              className="border-destructive/30 bg-destructive/10"
            >
              <AlertTitle>
                {t("mobileRevokeError", { name: pairing.revoke.error.name })}
              </AlertTitle>
              <AlertDescription>
                {pairing.revoke.error.message}
              </AlertDescription>
            </Alert>
          </div>
        ) : null}
      </SettingsSection>

      <RevokeDialog
        t={t}
        device={pairing.revoke.pending}
        revoking={pairing.revoke.revoking}
        onCancel={pairing.cancelRevoke}
        onConfirm={() => void pairing.confirmRevoke()}
      />
    </section>
  );
}

type Translate = { t: TranslationFunction };

function AddressRow({
  t,
  pairing,
  onRefresh,
}: Translate & {
  pairing: ReturnType<typeof useMobilePairing>;
  onRefresh: () => void;
}) {
  const labelId = useId();
  const [dialogOpen, setDialogOpen] = useState(false);
  const {
    interfaces,
    customAddresses,
    selectedAddress,
    selectedIsCustom,
    addressSave,
  } = pairing;
  const addresses = interfaces.status === "ready" ? interfaces.value : [];
  const loading = interfaces.status === "loading";
  const detected = selectedIsCustom
    ? undefined
    : addresses.find((entry) => entry.address === selectedAddress);
  const triggerLabel =
    selectedIsCustom && selectedAddress
      ? t("mobileAddressCustomOption", { address: selectedAddress })
      : detected
        ? addressLabel(detected)
        : t("mobileAddressNone");
  const itemClass =
    "font-workspace cursor-pointer rounded px-2 py-1.5 text-[13px] text-foreground";
  const sectionLabelClass =
    "font-workspace px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground";

  return (
    <SettingsRow
      title={t("mobileAddressTitle")}
      description={t("mobileAddressDescription")}
      control={
        <>
          <Label id={labelId} className="sr-only">
            {t("mobileAddressFieldLabel")}
          </Label>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                disabled={loading || addressSave.saving}
                aria-labelledby={labelId}
                className="font-workspace flex h-9 min-w-[220px] max-w-[320px] items-center justify-between gap-2 rounded-lg border border-border/40 bg-custom-background-90 px-3 text-[13px] text-foreground transition hover:border-border/60 hover:bg-custom-background-80 focus-visible:ring-1 focus-visible:ring-primary data-[state=open]:border-primary/60 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="truncate">{triggerLabel}</span>
                {addressSave.saving ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                ) : (
                  <ChevronDown className="h-4 w-4 shrink-0 text-current" />
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-[300px] rounded-lg border border-border/50 bg-custom-background-100 p-1"
            >
              <DropdownMenuLabel className={sectionLabelClass}>
                {t("mobileAddressFieldLabel")}
              </DropdownMenuLabel>
              <DropdownMenuSeparator className="mx-1 my-0.5 bg-border/60" />
              {addresses.map((entry) => (
                <DropdownMenuItem
                  key={entry.address}
                  onSelect={() => pairing.selectAddress(entry.address)}
                  className={itemClass}
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="truncate">{addressLabel(entry)}</span>
                    {!selectedIsCustom && entry.address === selectedAddress ? (
                      <Check className="h-4 w-4 shrink-0" />
                    ) : null}
                  </div>
                </DropdownMenuItem>
              ))}
              {customAddresses.length > 0 ? (
                <>
                  <DropdownMenuSeparator className="mx-1 my-0.5 bg-border/60" />
                  <DropdownMenuLabel className={sectionLabelClass}>
                    {t("mobileAddressCustomSection")}
                  </DropdownMenuLabel>
                  {customAddresses.map((address) => (
                    <CustomAddressItem
                      key={address}
                      t={t}
                      address={address}
                      selected={selectedIsCustom && address === selectedAddress}
                      className={itemClass}
                      onSelect={() => pairing.selectCustomAddress(address)}
                      onRemove={() => pairing.removeCustomAddress(address)}
                    />
                  ))}
                </>
              ) : null}
              <DropdownMenuSeparator className="mx-1 my-0.5 bg-border/60" />
              <DropdownMenuItem
                onSelect={() => setDialogOpen(true)}
                className={cn(itemClass, "gap-2 text-muted-foreground")}
              >
                <Plus className="h-3.5 w-3.5 shrink-0" />
                {t("mobileAddressAddCustom")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onRefresh}
            disabled={loading}
            aria-label={t("mobileAddressRefresh")}
            title={t("mobileAddressRefresh")}
            className="h-9 w-9 text-muted-foreground hover:text-foreground"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCcw className="h-3.5 w-3.5" />
            )}
          </Button>
          <CustomAddressDialog
            t={t}
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            onSubmit={pairing.addCustomAddress}
          />
        </>
      }
    >
      {interfaces.status === "loading" ? (
        <StatusLine>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("mobileAddressLoading")}
        </StatusLine>
      ) : interfaces.status === "error" ? (
        <Alert
          variant="destructive"
          className="border-destructive/30 bg-destructive/10"
        >
          <AlertTitle>{t("mobileAddressLoadError")}</AlertTitle>
          <AlertDescription>{interfaces.message}</AlertDescription>
        </Alert>
      ) : addressSave.error ? (
        <Alert
          variant="destructive"
          className="border-destructive/30 bg-destructive/10"
        >
          <AlertTitle>{t("mobileAddressSaveError")}</AlertTitle>
          <AlertDescription>{addressSave.error}</AlertDescription>
        </Alert>
      ) : !selectedAddress ? (
        <StatusLine>{t("mobileAddressEmpty")}</StatusLine>
      ) : null}
    </SettingsRow>
  );
}

/** A saved custom address: picking the row selects it, the X removes it. */
function CustomAddressItem({
  t,
  address,
  selected,
  className,
  onSelect,
  onRemove,
}: Translate & {
  address: string;
  selected: boolean;
  className: string;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const removeLabel = t("mobileAddressRemoveCustom", { address });
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      onKeyDown={(event) => {
        // The X is outside the menu's arrow-key focus order; Delete reaches it.
        if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          onRemove();
        }
      }}
      className={cn(className, "group pr-1")}
    >
      <div className="flex w-full items-center justify-between gap-2">
        <span className="truncate">
          {t("mobileAddressCustomOption", { address })}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {selected ? <Check className="h-4 w-4" /> : null}
          <button
            type="button"
            tabIndex={-1}
            aria-label={removeLabel}
            title={removeLabel}
            onClick={(event) => {
              // Remove without also selecting the row.
              event.preventDefault();
              event.stopPropagation();
              onRemove();
            }}
            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground opacity-0 transition hover:text-destructive group-hover:opacity-100 group-focus:opacity-100 group-data-[highlighted]:opacity-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>
    </DropdownMenuItem>
  );
}

function CustomAddressDialog({
  t,
  open,
  onOpenChange,
  onSubmit,
}: Translate & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (address: string) => Promise<void>;
}) {
  const inputId = useId();
  const hintId = useId();
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setValue("");
    setError(null);
    setSubmitting(false);
  }, [open]);

  const submit = async () => {
    if (!value.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(value);
      onOpenChange(false);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : String(submitError),
      );
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full max-w-[440px] border-custom-border-200 bg-custom-background-100 text-foreground">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("mobileCustomAddressTitle")}</DialogTitle>
            <DialogDescription>
              {t("mobileCustomAddressDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={inputId} className="font-workspace text-[13px]">
              {t("mobileCustomAddressLabel")}
            </Label>
            <Input
              id={inputId}
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
              }}
              placeholder={t("mobileCustomAddressPlaceholder")}
              aria-describedby={hintId}
              aria-invalid={error !== null}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              className="font-workspace text-[13px]"
            />
            <p
              id={hintId}
              className="font-workspace text-[12px] text-muted-foreground"
            >
              {t("mobileCustomAddressHint")}
            </p>
            {error ? (
              <p
                role="alert"
                className="font-workspace text-[12px] text-destructive"
              >
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              {t("mobileCustomAddressCancel")}
            </Button>
            <Button
              type="submit"
              disabled={!value.trim() || submitting}
              className="gap-1.5"
            >
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              {t("mobileCustomAddressUse")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function OfferView({
  t,
  offer,
  expired,
}: Translate & { offer: PairingOffer; expired: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <p role="status" className="sr-only">
        {expired ? "" : t("mobileQrReady")}
      </p>
      {expired ? (
        <div className="font-workspace flex h-[188px] w-[188px] items-center justify-center rounded-lg border border-dashed border-border/60 bg-custom-background-90 p-4 text-center text-[12px] text-muted-foreground">
          {t("mobileQrExpired")}
        </div>
      ) : offer.qrSvg ? (
        <img
          src={qrDataUrl(offer.qrSvg)}
          alt={t("mobileQrAlt")}
          width={188}
          height={188}
          className="h-[188px] w-[188px] rounded-lg border border-border/30 bg-white p-2"
          style={{ imageRendering: "pixelated" }}
        />
      ) : (
        <StatusLine>{t("mobileQrRenderFailed")}</StatusLine>
      )}
      {expired ? null : (
        <>
          <div className="font-workspace flex flex-col gap-0.5 text-[12px] text-muted-foreground">
            <span>{t("mobileQrInstructions")}</span>
            <span>{t("mobileQrRefreshNote")}</span>
          </div>
          <div className="font-workspace flex items-center gap-2 text-[12px]">
            <span className="text-muted-foreground">
              {t("mobileEndpointLabel")}
            </span>
            <code className="font-mono text-[12px] text-foreground">
              {offer.endpoint}
            </code>
          </div>
          <CopyLink t={t} pairingUrl={offer.pairingUrl} />
        </>
      )}
    </div>
  );
}

function CopyLink({ t, pairingUrl }: Translate & { pairingUrl: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state !== "copied") return;
    const timer = window.setTimeout(
      () => setState("idle"),
      COPY_CONFIRMATION_MS,
    );
    return () => window.clearTimeout(timer);
  }, [state]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pairingUrl);
      setState("copied");
    } catch {
      setState("failed");
    }
  };

  const label =
    state === "copied" ? t("mobileCopyLinkDone") : t("mobileCopyLink");

  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-workspace text-[12px] text-muted-foreground">
        {t("mobileCopyLinkLabel")}
      </span>
      <div className="flex items-center gap-2 rounded-lg border border-border/40 bg-custom-background-90 py-1 pl-3 pr-1">
        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
          {pairingUrl}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => void copy()}
          aria-label={label}
          title={label}
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
        >
          {state === "copied" ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
      {state === "failed" ? (
        <p className="font-workspace text-[12px] text-destructive">
          {t("mobileCopyLinkError")}
        </p>
      ) : null}
    </div>
  );
}

function FirewallDescription({
  t,
  offer,
}: Translate & { offer: PairingOffer | null }) {
  const port = offer ? endpointPort(offer.endpoint) : null;
  return (
    <>
      {port
        ? t("mobileFirewallDescriptionWithPort", { port })
        : t("mobileFirewallDescription")}
    </>
  );
}

function DevicesList({
  t,
  language,
  devices,
  codeOnScreen,
  onRetry,
  onRevoke,
}: Translate & {
  language: SupportedLanguage;
  devices: ReturnType<typeof useMobilePairing>["devices"];
  codeOnScreen: boolean;
  onRetry: () => void;
  onRevoke: (device: PairedDevice) => void;
}) {
  if (devices.status === "loading") {
    return (
      <div className="px-5 py-4">
        <StatusLine>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("mobileDevicesLoading")}
        </StatusLine>
      </div>
    );
  }
  if (devices.status === "error") {
    return (
      <div className="flex flex-col gap-2.5 px-5 py-4">
        <Alert
          variant="destructive"
          className="border-destructive/30 bg-destructive/10"
        >
          <AlertTitle>{t("mobileDevicesLoadError")}</AlertTitle>
          <AlertDescription>{devices.message}</AlertDescription>
        </Alert>
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRetry}
            className="font-workspace gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
          >
            <RefreshCcw className="h-3.5 w-3.5" />
            {t("mobileDevicesRetry")}
          </Button>
        </div>
      </div>
    );
  }
  if (devices.value.length === 0) {
    return (
      <div className="px-5 py-4">
        <StatusLine>
          {codeOnScreen
            ? t("mobileDevicesEmptyWithCode")
            : t("mobileDevicesEmpty")}
        </StatusLine>
      </div>
    );
  }
  const formatter = new Intl.DateTimeFormat(DATE_LOCALES[language], {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return (
    <>
      {devices.value.map((device) => (
        <div
          key={device.id}
          className="flex items-center justify-between gap-6 px-5 py-4"
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <Smartphone className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="font-workspace truncate text-[13px] font-medium text-foreground">
                {device.name}
              </div>
              <p className="font-workspace text-[12px] text-muted-foreground mt-0.5">
                {t("mobileDevicePairedOn", {
                  date: formatter.format(device.pairedAt),
                })}
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onRevoke(device)}
            aria-label={t("mobileDeviceRevokeLabel", { name: device.name })}
            className="font-workspace gap-1.5 text-[13px] text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("mobileDeviceRevoke")}
          </Button>
        </div>
      ))}
    </>
  );
}

function RevokeDialog({
  t,
  device,
  revoking,
  onCancel,
  onConfirm,
}: Translate & {
  device: PairedDevice | null;
  revoking: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog
      open={device !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("mobileRevokeConfirmTitle", { name: device?.name ?? "" })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("mobileRevokeConfirmDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={revoking}>
            {t("mobileRevokeCancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={revoking}
            onClick={(event) => {
              // Keep the dialog up until the server answers.
              event.preventDefault();
              onConfirm();
            }}
            className={cn(
              "gap-1.5 bg-destructive text-destructive-foreground hover:bg-destructive/90",
            )}
          >
            {revoking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {t("mobileDeviceRevoke")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function StatusLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-workspace flex items-center gap-1.5 text-[12px] text-muted-foreground">
      {children}
    </div>
  );
}
