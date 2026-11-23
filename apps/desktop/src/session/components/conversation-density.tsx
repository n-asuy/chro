import { createContext, useContext } from "react";
import { USER_MESSAGE_TWO_LINES_HEIGHT } from "./collapsible-message";

/**
 * How closely a conversation is set. `regular` is the session window's;
 * `compact` is for a narrow panel (about 390px): replies start at the request
 * bubble's left edge, text is 13px on 20px, and blocks are 12px apart.
 */
export type ConversationDensity = "regular" | "compact";

/** Class names, unless said otherwise. */
export interface DensityStyle {
  /** The scroll container. */
  viewport: string;
  /** One turn: its request, if any, and everything after it. */
  turn: string;
  turnWithRequest: string;
  turnWithoutRequest: string;
  /** The request, pinned while its replies scroll. */
  request: string;
  /** The box a long request collapses in, and the space under its bubble. */
  requestBox: string;
  requestInner: string;
  /** Height a long request collapses to, in px. */
  requestCollapsedHeight: number;
  /** Gradient start over the cut end of a collapsed request. */
  requestFade: string;
  /** Fades the replies passing beneath a pinned request. */
  requestUnderlap: string | null;
  /** The request's bubble. */
  bubble: string;
  /** One block of a turn: a reply, a group of steps, a notice. */
  block: string;
  /** The inset of a block's content, of a bordered error, of "Run with". */
  entry: string;
  errorEntry: string;
  modelInfo: string;
  /** A message with its actions row below it. */
  messageStack: string;
  /** The row of actions revealed on hover, and what it hangs from. */
  actions: string;
  actionsAnchor: string;
  /** Around the steps timeline, its header, one step, a step's text. */
  steps: string;
  stepsHeader: string;
  step: string;
  stepText: string;
  /** Message text; notices, quotes, raw output. */
  text: string;
  notice: string;
  quote: string;
  rawOutput: string;
  h1: string;
  h2: string;
  h3: string;
  h5: string;
  list: string;
  rule: string;
  table: string;
  tableText: string;
  tableCell: string;
}

const REGULAR: DensityStyle = {
  viewport: "overflow-y-auto px-6 py-5",
  turn: "relative",
  turnWithRequest: "",
  turnWithoutRequest: "",
  request: "sticky -top-5 z-10 w-full bg-background pt-5",
  requestBox: "",
  requestInner: "pb-2",
  // Two lines, the bubble's top padding (py-1) and a sliver of slack: the
  // request stays pinned, so a long one must not eat the reading space.
  requestCollapsedHeight: USER_MESSAGE_TWO_LINES_HEIGHT + 6,
  requestFade: "from-background",
  requestUnderlap: null,
  bubble: "gap-3 rounded-md px-4 py-1",
  block: "pb-2",
  entry: "gap-3 px-4 py-1",
  errorEntry: "gap-3 px-4 py-1",
  modelInfo: "px-4 py-1.5",
  messageStack: "space-y-2",
  actions: "h-6 px-1",
  actionsAnchor: "",
  steps: "px-2",
  stepsHeader: "px-2 py-1.5 text-[13px]",
  step: "px-2 py-1.5",
  stepText: "text-[13px]",
  text: "text-sm leading-relaxed",
  notice: "text-sm",
  quote: "text-sm",
  rawOutput: "px-4 py-1 text-sm",
  h1: "mt-6 text-xl",
  h2: "mt-5 text-lg",
  h3: "mt-4 text-base",
  h5: "mt-3 text-sm",
  list: "ps-6",
  rule: "my-6",
  table: "my-4",
  tableText: "text-sm",
  tableCell: "min-w-[10rem] px-4 py-2.5",
};

const COMPACT: DensityStyle = {
  // What scrolls out fades over the top 12px instead of being cut square
  // there; a pinned request sits below the fade. The right 12px hold the 10px
  // scrollbar (its room is kept, so content never reflows when it appears).
  viewport:
    "overflow-y-scroll pb-5 pl-3.5 pr-0.5 pt-3 [mask-image:linear-gradient(to_bottom,transparent,black_12px)]",
  turn: "relative flex flex-col gap-3",
  // The request brings its own 12px above it.
  turnWithRequest: "first:-mt-3",
  turnWithoutRequest: "pt-3 first:pt-0",
  request: "sticky -top-3 z-10 w-full bg-background pt-3",
  requestBox: "rounded-[14px]",
  requestInner: "",
  // Two 20px lines and the bubble's padding, so the cut bubble is whole.
  requestCollapsedHeight: 54,
  requestFade: "from-custom-sidebar-background-80",
  requestUnderlap:
    "absolute inset-x-0 top-full h-3 bg-gradient-to-b from-background to-transparent",
  bubble: "gap-3 rounded-[14px] px-[11px] py-[7px]",
  block: "",
  entry: "gap-3",
  errorEntry: "gap-3 px-[11px] py-[7px]",
  modelInfo: "",
  messageStack: "",
  // In the 12px below the message, so it needs no room of its own.
  actions: "absolute right-0 top-full z-20 h-5",
  actionsAnchor: "relative",
  steps: "",
  // The hover fill reaches 8px past the label, which stays on the text edge.
  stepsHeader: "-mx-2 -my-0.5 px-2 py-0.5 text-[12px] leading-5",
  step: "py-1",
  stepText: "text-[12px] leading-5",
  text: "text-[13px] leading-5",
  notice: "text-[13px] leading-5",
  quote: "text-[13px] leading-5",
  rawOutput: "text-[12px] leading-5",
  h1: "mt-4 text-[16px] leading-6",
  h2: "mt-4 text-[15px] leading-6",
  h3: "mt-3 text-[14px] leading-5",
  h5: "mt-3 text-[13px] leading-5",
  list: "ps-5",
  rule: "my-3",
  table: "my-3",
  tableText: "text-[12px] leading-[18px]",
  tableCell: "min-w-[5rem] px-2.5 py-1.5",
};

const STYLES: Record<ConversationDensity, DensityStyle> = {
  regular: REGULAR,
  compact: COMPACT,
};

const DensityContext = createContext<ConversationDensity>("regular");

/** Sets the density of the conversation inside it. */
export const ConversationDensityProvider = DensityContext.Provider;

export const densityStyle = (density: ConversationDensity): DensityStyle =>
  STYLES[density];

/** The styles of the conversation this component is in (regular outside one). */
export function useDensityStyle(): DensityStyle {
  return densityStyle(useContext(DensityContext));
}
