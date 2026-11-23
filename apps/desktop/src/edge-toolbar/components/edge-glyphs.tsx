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

export const GearGlyph = () => (
  <LineGlyph>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.75v2.5M12 18.75v2.5M2.75 12h2.5M18.75 12h2.5M5.46 5.46l1.77 1.77M16.77 16.77l1.77 1.77M5.46 18.54l1.77-1.77M16.77 7.23l1.77-1.77" />
    <circle cx="12" cy="12" r="6.25" />
  </LineGlyph>
);

export const PaletteGlyph = () => (
  <LineGlyph>
    <path d="M12 3.25a8.75 8.75 0 1 0 0 17.5c1.2 0 1.8-.8 1.8-1.7 0-1.4-1.3-1.6-1.3-2.8 0-1 .8-1.8 1.8-1.8h2.2a4.25 4.25 0 0 0 4.25-4.25c0-3.9-3.9-7-8.75-7Z" />
    <circle cx="7.6" cy="11.5" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="9.8" cy="7.6" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="14.4" cy="7.4" r="1.2" fill="currentColor" stroke="none" />
  </LineGlyph>
);

export const GlobeGlyph = () => (
  <LineGlyph>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17" />
    <path d="M12 3.5c2.4 2.3 3.6 5.2 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.2-3.6-8.5s1.2-6.2 3.6-8.5Z" />
  </LineGlyph>
);

export const ChevronRightGlyph = () => (
  <LineGlyph>
    <path d="M9.5 5.5 16 12l-6.5 6.5" />
  </LineGlyph>
);

export const ChevronLeftGlyph = () => (
  <LineGlyph>
    <path d="M14.5 5.5 8 12l6.5 6.5" />
  </LineGlyph>
);

export const KeyboardGlyph = () => (
  <LineGlyph>
    <rect x="2.75" y="6" width="18.5" height="12" rx="2" />
    <path d="M6.5 9.5h.01M10 9.5h.01M14 9.5h.01M17.5 9.5h.01M6.5 12.75h.01M17.5 12.75h.01M9 15.25h6" />
  </LineGlyph>
);

export const SpeakerGlyph = () => (
  <LineGlyph>
    <path d="M4.5 9.5h3l4.5-4v13l-4.5-4h-3z" />
    <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
  </LineGlyph>
);

export const EdgeGlyph = () => (
  <LineGlyph>
    <path d="M15 6.5 9.5 12l5.5 5.5" />
    <path d="M19.5 4v16" />
  </LineGlyph>
);

export const PowerGlyph = () => (
  <LineGlyph>
    <path d="M12 3.5v8" />
    <path d="M7.2 6.3a7.5 7.5 0 1 0 9.6 0" />
  </LineGlyph>
);

export const ExternalLinkGlyph = () => (
  <LineGlyph>
    <path d="M13.5 4.5h6v6M19.5 4.5 11 13" />
    <path d="M17.5 13.5v4a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h4" />
  </LineGlyph>
);
