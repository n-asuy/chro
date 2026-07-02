import { describe, expect, it } from "vitest";
import { applyAccentVars } from "./accent-apply";
import { ACCENT_VAR_NAMES, deriveAccentVars } from "./accent-derivation";

function makeStub() {
  const set: Record<string, string> = {};
  const removed: string[] = [];
  return {
    set,
    removed,
    style: {
      setProperty: (name: string, value: string) => {
        set[name] = value;
      },
      removeProperty: (name: string) => {
        removed.push(name);
      },
    },
  };
}

describe("applyAccentVars", () => {
  it("writes every derived variable to the element", () => {
    const stub = makeStub();
    const vars = deriveAccentVars("#0c6cbe", "light");

    applyAccentVars(stub, vars);

    for (const name of ACCENT_VAR_NAMES) {
      expect(stub.set[name]).toBe(vars[name]);
    }
    expect(stub.removed).toHaveLength(0);
  });

  it("clears exactly the managed variables when given null", () => {
    const stub = makeStub();

    applyAccentVars(stub, null);

    expect(stub.removed.sort()).toEqual([...ACCENT_VAR_NAMES].sort());
    expect(Object.keys(stub.set)).toHaveLength(0);
  });

  it("re-derives a different --primary per resolved mode", () => {
    // The hook passes the resolved mode, so light and dark must differ — this
    // is what keeps the accent legible after a theme flip.
    const light = deriveAccentVars("#0c6cbe", "light")["--primary"];
    const dark = deriveAccentVars("#0c6cbe", "dark")["--primary"];
    expect(light).not.toBe(dark);
  });

  it("is idempotent: re-applying the same vars yields the same writes", () => {
    const first = makeStub();
    const second = makeStub();
    const vars = deriveAccentVars("#e5484d", "dark");

    applyAccentVars(first, vars);
    applyAccentVars(second, vars);

    expect(first.set).toEqual(second.set);
  });
});
