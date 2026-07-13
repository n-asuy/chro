/**
 * Solid folder glyph (Heroicons v2 solid) matching the filled folder used in
 * the projects tree and the project home header. lucide only ships outline
 * folders, so the fillable path lives here.
 */
export function FolderSolidIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M19.5 21a3 3 0 0 0 3-3V9a3 3 0 0 0-3-3h-5.379a.75.75 0 0 1-.53-.22L11.47 3.66A2.25 2.25 0 0 0 9.879 3H4.5a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h15Z" />
    </svg>
  );
}
