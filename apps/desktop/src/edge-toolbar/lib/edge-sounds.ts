/**
 * The edge toolbar's interface sounds, the mock's set: the microphone turning
 * on and off, and a region being confirmed. Played at the mock's level for
 * interface sounds.
 */
export type EdgeSound = "record-start" | "record-stop" | "confirm";

const VOLUME = 0.35;
const loaded = new Map<EdgeSound, HTMLAudioElement>();

export function playEdgeSound(sound: EdgeSound): void {
  let base = loaded.get(sound);
  if (!base) {
    base = new Audio(`/sounds/edge/${sound}.wav`);
    loaded.set(sound, base);
  }
  const voice = base.cloneNode() as HTMLAudioElement;
  voice.volume = VOLUME;
  voice.play().catch(() => {});
}
