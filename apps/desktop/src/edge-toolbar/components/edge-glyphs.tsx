import type { ReactNode } from "react";

/** A 24-unit line glyph stroked with the text colour (the mock's icon set). */
function LineGlyph({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="edge-glyph"
    >
      {children}
    </svg>
  );
}

export const MicGlyph = () => (
  <LineGlyph>
    <rect x="9" y="2.75" width="6" height="11.5" rx="3" />
    <path d="M5.75 11a6.25 6.25 0 0 0 12.5 0" />
    <path d="M12 17.25v3.5" />
    <path d="M8.75 20.75h6.5" />
  </LineGlyph>
);

export const CameraGlyph = () => (
  <LineGlyph>
    <path d="M4.75 7.25h2.6l1.4-2.1a1 1 0 0 1 .83-.45h4.84a1 1 0 0 1 .83.45l1.4 2.1h2.6a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H4.75a2 2 0 0 1-2-2v-8.5a2 2 0 0 1 2-2Z" />
    <circle cx="12" cy="13.1" r="3.4" />
  </LineGlyph>
);

export const CheckGlyph = () => (
  <LineGlyph>
    <path d="M5.5 12.5 10 17l8.5-9.5" />
  </LineGlyph>
);

export const ArrowUpGlyph = () => (
  <LineGlyph>
    <path d="M12 19.5v-15M5.75 10.75 12 4.5l6.25 6.25" />
  </LineGlyph>
);
