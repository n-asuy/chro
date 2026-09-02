/// <reference types="vite/client" />

declare const __PERF_ENABLED__: boolean;
declare const __APP_VERSION__: string;

/**
 * Forces local dev-event recording on in a production build, for dogfooding a
 * packaged app. Dev builds record regardless; see `lib/dev-events.ts`.
 */
declare const __DEV_EVENTS_FORCED__: boolean;

/** Repo-root CHANGELOG.md, inlined at build time by the `chro-changelog` plugin. */
declare module "virtual:chro-changelog" {
  const changelog: string;
  export default changelog;
}

interface ImportMetaEnv {
  readonly VITE_APP_VERSION?: string;
  readonly VITE_BUILD_DATE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
