import { TurboModuleRegistry } from "react-native";

import type { Spec as ChroNativeSpec } from "./specs/NativeChro";

export type ChroNative = {
  readonly isLinked: boolean;
  echo(input: string): string;
  getVersion(): string;
};

const fallbackNative: ChroNative = {
  isLinked: false,
  echo(input) {
    return `fallback:${input}`;
  },
  getVersion() {
    return "chro-mobile-native pending";
  },
};

let cachedNative: ChroNative | undefined;

export function getChroNative(): ChroNative {
  if (cachedNative) {
    return cachedNative;
  }

  const nativeModule = TurboModuleRegistry.get<ChroNativeSpec>("ChroNative");

  cachedNative = nativeModule
    ? {
        isLinked: true,
        echo(input) {
          return nativeModule.echo(input);
        },
        getVersion() {
          return nativeModule.getVersion();
        },
      }
    : fallbackNative;

  return cachedNative;
}
