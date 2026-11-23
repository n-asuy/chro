import type { CapsuleDotStatus } from "../domain/capsule-dots";

/**
 * The ring around a session's tile (the mock's quiet ring), sized to stay
 * inside the 34 pt capsule: one thin ring for the session's state, drawn
 * outside the icon. Waiting: a full amber ring breathing slowly; running: a
 * faint blue track with a short blue arc orbiting; finished unread: a full
 * green ring; read: nothing.
 */
export function EdgeRing({ status }: { status: CapsuleDotStatus }) {
  if (status === "idle") return null;
  return (
    <svg viewBox="0 0 30 30" aria-hidden="true" className="edge-ring">
      {status === "running" ? (
        <>
          <circle cx="15" cy="15" r="14" className="edge-ring-track" />
          <circle
            cx="15"
            cy="15"
            r="14"
            pathLength="100"
            strokeDasharray="22 78"
            className="edge-ring-orbit"
          />
        </>
      ) : (
        <circle cx="15" cy="15" r="14" data-status={status} />
      )}
    </svg>
  );
}
