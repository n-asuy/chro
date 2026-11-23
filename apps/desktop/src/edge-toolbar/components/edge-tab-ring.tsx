import type { CapsuleDotStatus } from "../domain/capsule-dots";

/**
 * A session's mark on the collapsed tab: a 7 pt thin ring in the capsule's
 * vocabulary. Waiting: an amber ring breathing; running: a faint blue track
 * with a short blue arc turning; finished unread: a green ring; read: a
 * faint grey ring, so reading a session never changes the tab's length.
 */
export function EdgeTabRing({ status }: { status: CapsuleDotStatus }) {
  return (
    <svg viewBox="0 0 7 7" aria-hidden="true" className="edge-tab-ring">
      {status === "running" ? (
        <>
          <circle cx="3.5" cy="3.5" r="2.9" className="edge-tab-ring-track" />
          <circle
            cx="3.5"
            cy="3.5"
            r="2.9"
            pathLength="100"
            strokeDasharray="30 70"
            className="edge-tab-ring-arc"
          />
        </>
      ) : (
        <circle cx="3.5" cy="3.5" r="2.9" data-status={status} />
      )}
    </svg>
  );
}
