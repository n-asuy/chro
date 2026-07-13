// Parse the import table of a Windows PE image so the release pipeline can
// prove a sidecar is statically linked against the C runtime. A statically
// linked (/MT) binary imports only OS libraries; a dynamically linked (/MD) one
// additionally imports the VC++ Redistributable CRT, which is absent on clean
// Windows machines and produces the "VCRUNTIME140.dll was not found" launch
// failure. We read the PE directly rather than shell out to `dumpbin`, which is
// not on PATH outside a Visual Studio developer prompt.

// DLLs that live only inside the VC++ Redistributable, never on a clean Windows
// install: `vcruntime*`/`msvcp*`/`concrt*` are the C/C++ runtime and the
// `api-ms-win-crt-*` forwarders are what the dynamic (/MD) UCRT pulls in.
export const REDIST_ONLY_CRT_DLL =
  /^(vcruntime\d+|msvcp\d+|concrt\d+|api-ms-win-crt-)/i;

/** Read every DLL name in a PE image's import directory. */
export function importedDllNames(buf: Buffer): string[] {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) {
    throw new Error("not a PE image (missing MZ header)");
  }
  const peOffset = buf.readUInt32LE(0x3c);
  if (peOffset + 24 > buf.length || buf.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error("not a PE image (missing PE signature)");
  }
  const coff = peOffset + 4;
  const numberOfSections = buf.readUInt16LE(coff + 2);
  const sizeOfOptionalHeader = buf.readUInt16LE(coff + 16);
  const optional = coff + 20;
  const magic = buf.readUInt16LE(optional);
  // Data directories start at 0x70 in a PE32+ optional header, 0x60 in PE32;
  // entry #1 (offset +8 past the export entry) is the import table.
  const dataDirOffset = magic === 0x20b ? 0x70 : 0x60;
  const importDirRva = buf.readUInt32LE(optional + dataDirOffset + 8);
  if (importDirRva === 0) {
    return [];
  }

  const sections: Array<{ va: number; size: number; raw: number }> = [];
  const sectionTable = optional + sizeOfOptionalHeader;
  for (let i = 0; i < numberOfSections; i++) {
    const s = sectionTable + i * 40;
    sections.push({
      va: buf.readUInt32LE(s + 12),
      size: Math.max(buf.readUInt32LE(s + 8), buf.readUInt32LE(s + 16)),
      raw: buf.readUInt32LE(s + 20),
    });
  }
  const toOffset = (rva: number): number | null => {
    for (const s of sections) {
      if (rva >= s.va && rva < s.va + s.size) {
        return s.raw + (rva - s.va);
      }
    }
    return null;
  };
  const readCString = (offset: number): string => {
    let end = offset;
    while (end < buf.length && buf[end] !== 0) end++;
    return buf.toString("ascii", offset, end);
  };

  const names: string[] = [];
  let entry = toOffset(importDirRva);
  if (entry === null) {
    return names;
  }
  // IMAGE_IMPORT_DESCRIPTOR is 20 bytes; the array ends at an all-zero entry.
  // The imported DLL's name RVA sits at offset 12.
  for (; entry + 20 <= buf.length; entry += 20) {
    const originalFirstThunk = buf.readUInt32LE(entry);
    const nameRva = buf.readUInt32LE(entry + 12);
    if (originalFirstThunk === 0 && nameRva === 0) break;
    if (nameRva === 0) continue;
    const nameOffset = toOffset(nameRva);
    if (nameOffset !== null) names.push(readCString(nameOffset));
  }
  return names;
}

/** The redistributable-CRT DLLs a PE image imports, empty when statically linked. */
export function redistCrtImports(buf: Buffer): string[] {
  return importedDllNames(buf).filter((dll) => REDIST_ONLY_CRT_DLL.test(dll));
}
