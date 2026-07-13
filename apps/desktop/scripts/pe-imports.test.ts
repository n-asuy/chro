import { describe, expect, it } from "vitest";

import { importedDllNames, redistCrtImports } from "./pe-imports";

// Build a minimal but structurally valid PE32+ image whose import directory
// names a single DLL. Layout keeps section RVA == file offset so RVA→offset is
// the identity, which is all the parser needs to resolve names.
function makePe(dllName: string): Buffer {
  const buf = Buffer.alloc(0x1400);
  const peOffset = 0x80;
  const optional = peOffset + 4 + 20;
  const sizeOfOptionalHeader = 0x70 + 16 * 8; // PE32+ header + 16 data dirs
  const importDirRva = 0x400;
  const descriptorOffset = importDirRva; // section VA == file offset
  const nameRva = 0x420;

  buf.write("MZ", 0, "ascii");
  buf.writeUInt32LE(peOffset, 0x3c);
  buf.writeUInt32LE(0x00004550, peOffset); // "PE\0\0"
  buf.writeUInt16LE(0x8664, peOffset + 4); // Machine: x64
  buf.writeUInt16LE(1, peOffset + 4 + 2); // NumberOfSections
  buf.writeUInt16LE(sizeOfOptionalHeader, peOffset + 4 + 16);

  buf.writeUInt16LE(0x20b, optional); // Magic: PE32+
  // Data directory entry #1 (import) lives at optional + 0x70 + 8.
  buf.writeUInt32LE(importDirRva, optional + 0x70 + 8);
  buf.writeUInt32LE(40, optional + 0x70 + 12); // arbitrary non-zero size

  // Single section covering the import data; VirtualAddress == PointerToRawData.
  const section = optional + sizeOfOptionalHeader;
  buf.write(".idata", section, "ascii");
  buf.writeUInt32LE(0x1000, section + 8); // VirtualSize
  buf.writeUInt32LE(0x400, section + 12); // VirtualAddress
  buf.writeUInt32LE(0x1000, section + 16); // SizeOfRawData
  buf.writeUInt32LE(0x400, section + 20); // PointerToRawData

  // One import descriptor pointing at the DLL name, then the zero terminator.
  buf.writeUInt32LE(nameRva, descriptorOffset + 12); // Name RVA
  // descriptorOffset + 20 stays zeroed → terminator.
  buf.write(dllName, nameRva, "ascii");

  return buf;
}

describe("importedDllNames", () => {
  it("extracts the imported DLL name from a PE import table", () => {
    expect(importedDllNames(makePe("KERNEL32.dll"))).toEqual(["KERNEL32.dll"]);
  });

  it("rejects a buffer that is not a PE image", () => {
    expect(() => importedDllNames(Buffer.alloc(64))).toThrow(/not a PE image/);
  });
});

describe("redistCrtImports", () => {
  it("flags a dynamically linked binary that imports VCRUNTIME140.dll", () => {
    expect(redistCrtImports(makePe("VCRUNTIME140.dll"))).toEqual([
      "VCRUNTIME140.dll",
    ]);
  });

  it("flags the api-ms-win-crt UCRT forwarders", () => {
    expect(
      redistCrtImports(makePe("api-ms-win-crt-runtime-l1-1-0.dll")),
    ).toEqual(["api-ms-win-crt-runtime-l1-1-0.dll"]);
  });

  it("passes a statically linked binary that imports only OS libraries", () => {
    expect(redistCrtImports(makePe("KERNEL32.dll"))).toEqual([]);
  });
});
