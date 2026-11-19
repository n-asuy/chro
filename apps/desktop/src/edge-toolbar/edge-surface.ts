/** Route of the edge toolbar window. */
export const EDGE_ROUTE_PATH = "/edge";

/** Whether this document is the edge toolbar window rather than a session window. */
export function isEdgeSurface(pathname: string): boolean {
  return (
    pathname === EDGE_ROUTE_PATH || pathname.startsWith(`${EDGE_ROUTE_PATH}/`)
  );
}
