import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('bridge', {
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  platform: process.platform,
  pathForFile: (f: File) => webUtils.getPathForFile(f)
})
