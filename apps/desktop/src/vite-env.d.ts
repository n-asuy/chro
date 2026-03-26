/// <reference types="vite/client" />

declare const __PERF_ENABLED__: boolean;
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_APP_VERSION?: string;
  readonly VITE_BUILD_DATE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
