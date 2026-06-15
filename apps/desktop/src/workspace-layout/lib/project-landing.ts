/**
 * Resolve the URL to land on when switching to (or opening) a project.
 *
 * Lands on the project overview — a minimal home surface listing the
 * project's recent sessions — rather than restoring the last open tab, so
 * switching projects always opens a predictable, scannable starting point.
 * Any persisted tabs remain available in the tab bar; the overview is simply
 * focused on top of them.
 */
export function resolveProjectLandingPath(
  _projectUuid: string,
  projectSlug: string,
): string {
  return `/projects/${encodeURIComponent(projectSlug)}`;
}
