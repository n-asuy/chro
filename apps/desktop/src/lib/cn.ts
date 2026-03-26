type ClassDictionary = Record<string, boolean | undefined | null>;
type ClassValue =
  | string
  | number
  | null
  | undefined
  | false
  | ClassDictionary
  | ClassValue[];

const normalizeClassValue = (value: ClassValue): string => {
  if (!value) return "";
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (Array.isArray(value))
    return value.map(normalizeClassValue).filter(Boolean).join(" ");
  return Object.entries(value)
    .filter(([, condition]) => Boolean(condition))
    .map(([key]) => key)
    .join(" ");
};

export const cn = (...classes: ClassValue[]) =>
  classes.map(normalizeClassValue).filter(Boolean).join(" ");
