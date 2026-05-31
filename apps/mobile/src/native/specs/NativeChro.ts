import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

export interface Spec extends TurboModule {
  echo(input: string): string;
  getVersion(): string;
}

export default TurboModuleRegistry.getEnforcing<Spec>("ChroNative");
