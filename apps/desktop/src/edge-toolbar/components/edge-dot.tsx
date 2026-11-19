import type { CSSProperties } from "react";
import type { CapsuleDotStatus } from "../domain/capsule-dots";

/**
 * A session's dot, in the mock's four states: a blue arc spinning while it
 * runs, an amber dot that breathes while it needs the user, a green dot when
 * it finished unread, a small grey dot otherwise. The arc and the dot are
 * always drawn, so a change of state scales and fades between them (see
 * `edge-toolbar.css`); `index` offsets each arc's spin like the mock.
 */
export function EdgeDot({
  status,
  index,
}: {
  status: CapsuleDotStatus;
  index: number;
}) {
  return (
    <span
      className="edge-status"
      data-status={status}
      style={{ "--edge-dot-index": index } as CSSProperties}
      aria-hidden="true"
    >
      <svg viewBox="0 0 10 10">
        <circle
          cx="5"
          cy="5"
          r="3.9"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray="17 7.5"
        />
      </svg>
    </span>
  );
}
