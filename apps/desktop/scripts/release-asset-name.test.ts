import { describe, expect, it } from "vitest";

import { releaseAssetName } from "./release-asset-name";

const version = "0.1.51";

describe("releaseAssetName", () => {
  it("drops the version so installers keep a stable name across releases", () => {
    expect(releaseAssetName("Chro_0.1.51_aarch64.dmg", version, "aarch64-apple-darwin")).toBe("Chro_aarch64.dmg");
    expect(releaseAssetName("Chro_0.1.51_x64.dmg", version, "x86_64-apple-darwin")).toBe("Chro_x64.dmg");
    expect(releaseAssetName("Chro_0.1.51_x64-setup.exe", version, "x86_64-pc-windows-msvc")).toBe("Chro_x64-setup.exe");
    expect(releaseAssetName("chro_0.1.51_amd64.deb", version, "x86_64-unknown-linux-gnu")).toBe("chro_amd64.deb");
  });

  it("scopes the mac updater bundle by arch, since Tauri names it without one", () => {
    expect(releaseAssetName("Chro.app.tar.gz", version, "aarch64-apple-darwin")).toBe("Chro_aarch64.app.tar.gz");
    expect(releaseAssetName("Chro.app.tar.gz.sig", version, "x86_64-apple-darwin")).toBe("Chro_x64.app.tar.gz.sig");
  });

  it("leaves names that carry neither the version nor a mac updater suffix untouched", () => {
    expect(releaseAssetName("latest.json", version, "aarch64-apple-darwin")).toBe("latest.json");
    expect(releaseAssetName("Chro.app.tar.gz", version, "x86_64-pc-windows-msvc")).toBe("Chro.app.tar.gz");
  });
});
