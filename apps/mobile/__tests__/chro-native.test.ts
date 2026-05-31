jest.mock("react-native", () => ({
  TurboModuleRegistry: {
    get: () => null,
  },
}));

import { getChroNative } from "../src/native/chro-native";

test("uses fallback native module before platform bridge is linked", () => {
  const native = getChroNative();

  expect(native.isLinked).toBe(false);
  expect(native.getVersion()).toBe("chro-mobile-native pending");
  expect(native.echo("mobile")).toBe("fallback:mobile");
});
