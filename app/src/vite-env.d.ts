/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BOTTAP_SANDBOX?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
