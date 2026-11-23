/**
 * Session icons: thin line drawings on a 24-unit grid, stroked at 1.4 with
 * round caps and joins in the current colour. Each icon is one path; circles
 * and rounded rectangles are written with the helpers below so every drawing
 * stays a single `d` string.
 *
 * A session's icon is picked by the call that titles it (the server sends the
 * model these names, `TASK_ICONS` in `crates/executors/src/session_title.rs`;
 * a test keeps the two lists identical) or chosen by a person.
 */

/** A full circle as path data. */
function circle(cx: number, cy: number, r: number): string {
  return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;
}

/** An ellipse as path data. */
function ellipse(cx: number, cy: number, rx: number, ry: number): string {
  return `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0z`;
}

/** A rectangle with rounded corners as path data. */
function rect(x: number, y: number, w: number, h: number, r = 0): string {
  if (r === 0) return `M${x} ${y}h${w}v${h}h${-w}z`;
  return [
    `M${x + r} ${y}h${w - 2 * r}`,
    `a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}`,
    `a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}`,
    `a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}`,
    `a${r} ${r} 0 0 1 ${r} ${-r}z`,
  ].join("");
}

/** A dot (a zero-length segment with round caps). */
function dot(x: number, y: number): string {
  return `M${x} ${y}h.01`;
}

const ICONS = {
  agent: `${rect(4, 7, 16, 12, 3.5)}M12 3v4M9.5 11.5v2.5M14.5 11.5v2.5`,
  search: `${circle(10.5, 10.5, 6)}M15 15l5.5 5.5`,
  pencil:
    "M4 20l1-4.2L16.2 4.6a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L8.2 19 4 20zM14.5 6.3l3.2 3.2",
  shield: "M12 3l7 2.8V11c0 4.8-3 8.2-7 10-4-1.8-7-5.2-7-10V5.8z",
  flask:
    "M9 3h6M10 3v6.2L4.8 18a2 2 0 0 0 1.7 3h11a2 2 0 0 0 1.7-3L14 9.2V3M7.3 15h9.4",
  book: "M12 6.5C10.5 5 8 4.5 4 4.5v14c4 0 6.5.5 8 2 1.5-1.5 4-2 8-2v-14c-4 0-6.5.5-8 2zM12 6.5v14",
  box: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9",
  chat: `M4 5h16v11h-9l-4.5 4v-4H4z${dot(8.5, 10.5)}${dot(12, 10.5)}${dot(15.5, 10.5)}`,
  eye: `M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6S2.5 12 2.5 12z${circle(12, 12, 2.8)}`,
  bolt: "M13.5 2.5L5 13.5h6.2l-1.2 8L19 10.5h-6.2z",
  terminal: `${rect(3, 4.5, 18, 15, 2.5)}M7 9.5l3 2.5-3 2.5M12.5 15h4.5`,
  globe: `${circle(12, 12, 9)}M3 12h18M12 3c2.5 2.5 3.6 5.5 3.6 9s-1.1 6.5-3.6 9c-2.5-2.5-3.6-5.5-3.6-9S9.5 5.5 12 3z`,
  code: "M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5M13.5 5l-3 14",
  server: `${rect(4, 4, 16, 7, 2)}${rect(4, 13, 16, 7, 2)}${dot(7.5, 7.5)}${dot(7.5, 16.5)}M11 7.5h5.5M11 16.5h5.5`,
  database: `${ellipse(12, 6, 7.5, 2.8)}M4.5 6v12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8`,
  cloud:
    "M7.5 17.9a4.25 4.25 0 0 1-.6-8.46 5.5 5.5 0 0 1 10.5 1.2 3.65 3.65 0 0 1-.4 7.26z",
  phone: `${rect(7, 3, 10, 18, 2.5)}M11 17.5h2`,
  monitor: `${rect(3, 4, 18, 12, 2)}M9 20h6M12 16v4`,
  browser: `${rect(3, 4.5, 18, 15, 2.5)}M3 9h18${dot(6.25, 6.75)}${dot(8.75, 6.75)}`,
  branch: `${circle(7, 5.5, 2)}${circle(7, 18.5, 2)}${circle(17, 7.5, 2)}M7 7.5v9M17 9.5c0 3.5-2 5-5 5.5S7.6 16 7.2 16.6`,
  bug: `${rect(7.5, 7.5, 9, 12.5, 4.5)}M9.5 7.6a2.5 2.5 0 0 1 5 0M12 12v8M3.5 13.5h4M16.5 13.5h4M4.5 8.5l3 2M19.5 8.5l-3 2M4.5 19l3-2M19.5 19l-3-2`,
  rocket: `M12 3.5c3 2.5 4.5 6 4.5 10v4h-9v-4c0-4 1.5-7.5 4.5-10zM7.5 13.5L4.5 16v3.5l3-2M16.5 13.5l3 2.5v3.5l-3-2M10 17.5l.5 3h3l.5-3${circle(12, 10.5, 1.6)}`,
  chart: "M4 4v16h16M8 15l3.5-4 3 2.5L20 7",
  coin: `${circle(12, 12, 9)}M14.8 9c-.5-.9-1.6-1.4-2.8-1.4-1.6 0-2.8.9-2.8 2.2 0 3 5.8 1.6 5.8 4.6 0 1.3-1.3 2.3-3 2.3-1.3 0-2.5-.6-3-1.6M12 5.6v2M12 16.7v1.7`,
  cart: `M3 4h2.5l2.2 10.5a1.5 1.5 0 0 0 1.5 1.2h7.9a1.5 1.5 0 0 0 1.5-1.1L20.5 8H6.4${circle(9.5, 19.5, 1.3)}${circle(17, 19.5, 1.3)}`,
  mail: `${rect(3, 5.5, 18, 13, 2.5)}M3.8 7.5l8.2 5.8 8.2-5.8`,
  calendar: `${rect(3.5, 5, 17, 15.5, 2.5)}M3.5 10h17M8 3v4M16 3v4`,
  music: `M9 18V5.5l11-2V16${circle(6.5, 18, 2.5)}${circle(17.5, 16, 2.5)}`,
  camera: `M3.5 8.5a2 2 0 0 1 2-2h2.3L9.5 4h5l1.7 2.5h2.3a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z${circle(12, 13, 3.6)}`,
  image: `${rect(3.5, 4.5, 17, 15, 2.5)}${circle(9, 9.5, 1.6)}M20.5 15.5L16 11l-9.5 8.5`,
  map: "M3.5 6.5L9 4l6 2.5L20.5 4v13.5L15 20l-6-2.5-5.5 2.5zM9 4v13.5M15 6.5V20",
  home: "M4 10.5L12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19zM9.5 20.5v-6h5v6",
  building:
    "M5 20.5V5a1.5 1.5 0 0 1 1.5-1.5h7A1.5 1.5 0 0 1 15 5v15.5M15 9.5h3.5A1.5 1.5 0 0 1 20 11v9.5M3.5 20.5h17M8.5 7.5h3M8.5 11h3M8.5 14.5h3",
  people: `${circle(9, 8.5, 3.2)}M3 19.5c.6-3.2 3-5 6-5s5.4 1.8 6 5M15.5 5.6a3.2 3.2 0 0 1 0 5.8M17.5 14.8c1.8.6 3.1 2.2 3.5 4.7`,
  user: `${circle(12, 8, 4)}M4.5 20.5c.8-4 3.7-6.2 7.5-6.2s6.7 2.2 7.5 6.2`,
  heart:
    "M12 19.4s-8-4.7-8-10.5A4.5 4.5 0 0 1 12 6.2a4.5 4.5 0 0 1 8 2.7c0 5.8-8 10.5-8 10.5z",
  star: "M12 3.9l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 17.3l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z",
  flag: "M5.5 21V4M5.5 4.5c3-1.5 5.5 1.5 8.5 0s4.5-.5 4.5-.5v9s-1.5-1-4.5.5-5.5-1.5-8.5 0",
  leaf: "M4.5 19.5C3 10 8.5 4 20 4c0 11.5-6 17-15.5 15.5zM4.5 19.5L13 11",
  sun: `${circle(12, 12, 4)}M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6`,
  moon: "M19.5 14.5A8 8 0 1 1 9.5 4.5a6.5 6.5 0 0 0 10 10z",
  key: `${circle(8, 15.5, 4.5)}M11.2 12.3L20 3.5M16.5 7l2.5 2.5M14.5 9l2 2`,
  lock: `${rect(4.5, 10.5, 15, 10, 2.5)}M8 10.5v-3a4 4 0 0 1 8 0v3M12 14.5v2`,
  gift: `${rect(3.5, 7.4, 17, 4, 1)}M5 11.4v7.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7.5M12 7.4v12.5M12 7.4C10.5 3.9 7 3.4 7 5.6 7 6.9 9 7.4 12 7.4zM12 7.4c1.5-3.5 5-4 5-1.8C17 6.9 15 7.4 12 7.4z`,
  coffee:
    "M4 9.5h12V15a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5zM16 11h1.5a2.5 2.5 0 0 1 0 5h-1.8M7.5 4v2.5M11 4v2.5",
  gamepad: `M7.5 6.3h9a4.5 4.5 0 0 1 4.4 3.6l.9 4.8a2.6 2.6 0 0 1-4.5 2.2l-1.8-2.1h-7l-1.8 2.1a2.6 2.6 0 0 1-4.5-2.2l.9-4.8A4.5 4.5 0 0 1 7.5 6.3zM7.5 9.3v3M6 10.8h3${dot(15.5, 10.3)}${dot(17.5, 12.05)}`,
  puzzle:
    "M4 6.1h5.75a2.25 2.25 0 1 1 4.5 0H18v5.75a2.25 2.25 0 1 1 0 4.5v3.75H4z",
  wrench:
    "M7.06 19.06l6.2-6.2a4.5 4.5 0 0 0 5.96-6.1L16.9 9.08 14.92 7.1l2.32-2.32a4.5 4.5 0 0 0-6.1 5.96l-6.2 6.2a1.5 1.5 0 0 0 2.12 2.12z",
} as const;

export type TaskIconName = keyof typeof ICONS;

/** Every icon, in the set's order (the order the picker shows them in). */
export const TASK_ICON_NAMES = Object.keys(ICONS) as TaskIconName[];

/**
 * Drawn for a session that has no icon yet: one titled before icons existed,
 * or whose titling call failed or named no icon.
 */
export const DEFAULT_TASK_ICON: TaskIconName = "chat";

export function isTaskIconName(value: string): value is TaskIconName {
  return Object.hasOwn(ICONS, value);
}

/** The icon's path data (24-unit grid). */
export function taskIconPath(name: TaskIconName): string {
  return ICONS[name];
}

/** The session's icon when it is one of the set, else the neutral default. */
export function taskIcon(icon: string | null | undefined): TaskIconName {
  return icon && isTaskIconName(icon) ? icon : DEFAULT_TASK_ICON;
}
