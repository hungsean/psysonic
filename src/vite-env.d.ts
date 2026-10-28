/// <reference types="vite/client" />

declare global {
  interface ImportMetaEnv {
    readonly VITE_PSYSONIC_FLATPAK?: string;
    /** `1` skips the startup update check (self-built forks). */
    readonly VITE_PSYSONIC_DISABLE_UPDATER?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }

  interface Window {
    __psyHidden?: boolean;
    __psyBlurred?: boolean;
    __psyStartMinimizedToTray?: boolean;
    __psyIsTilingWm?: boolean;
    __psyLifecycleGeneration?: number;
  }
}

export {};
