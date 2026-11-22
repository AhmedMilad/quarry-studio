export {}
declare global {
  interface Window {
    bridge: {
      invoke: (channel: string, ...args: unknown[]) => Promise<{ ok: boolean; data?: unknown; error?: string }>
      platform: string
      pathForFile: (f: File) => string
    }
  }
}
