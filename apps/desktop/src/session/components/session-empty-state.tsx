type SessionEmptyStateProps = {
  title: string;
  description?: string;
};

export function SessionEmptyState({
  title,
  description,
}: SessionEmptyStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="flex max-w-[30rem] flex-col items-center gap-5">
        <img
          src="/logo_chro_symbol.png"
          alt="Chro"
          width={56}
          height={56}
          className="h-14 w-14 select-none opacity-70 dark:invert"
          draggable={false}
        />
        <div className="space-y-2">
          <h1 className="text-[20px] font-light tracking-[-0.03em] text-foreground">
            {title}
          </h1>
          {description ? (
            <p className="text-sm font-light leading-6 text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
