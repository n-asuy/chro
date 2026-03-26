type UpdateApi = NonNullable<
  NonNullable<typeof window.desktop>["update"]
>;

const getDesktop = () =>
  typeof window === "undefined" ? undefined : window.desktop;

export const getUpdateApi = (): UpdateApi | undefined => {
  const desktop = getDesktop();
  return desktop?.update;
};

export const getVersion = (): (() => Promise<string>) | undefined => {
  const desktop = getDesktop();
  return desktop?.getVersion;
};
