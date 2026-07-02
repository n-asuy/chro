// apca-w3 ships no type declarations. Declare only the surface we use: APCA
// perceptual contrast (Lc) from sRGB luminance values.
declare module "apca-w3" {
  /** Linearized luminance (Y) from an sRGB [r, g, b] triplet (0-255). */
  export function sRGBtoY(rgb: [number, number, number]): number;
  /** APCA contrast (Lc) of text luminance against background luminance. */
  export function APCAcontrast(
    textY: number,
    bgY: number,
    places?: number,
  ): number | string;
}
