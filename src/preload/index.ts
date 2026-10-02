/**
 * Preload bridge. Runs sandboxed with contextIsolation; exposes a tiny, allowlisted API.
 * No Node APIs and no secrets ever reach the renderer.
 */
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { EVENT_CHANNELS, INVOKE_CHANNELS } from '../shared/ipc'
import type { BluelyApi } from './api'

const invokeSet = new Set<string>(INVOKE_CHANNELS)
const eventSet = new Set<string>(EVENT_CHANNELS)

const api: BluelyApi = {
  invoke(channel, payload) {
    if (!invokeSet.has(channel)) {
      return Promise.reject(new Error(`IPC channel not allowed: ${String(channel)}`))
    }
    return ipcRenderer.invoke(channel, payload)
  },
  on(event, listener) {
    if (!eventSet.has(event)) throw new Error(`IPC event not allowed: ${String(event)}`)
    const wrapped = (_e: IpcRendererEvent, payload: unknown) => {
      ;(listener as (p: unknown) => void)(payload)
    }
    ipcRenderer.on(event, wrapped)
    return () => {
      ipcRenderer.removeListener(event, wrapped)
    }
  },
  getPathForFile(file) {
    return webUtils.getPathForFile(file)
  },
  platform: process.platform,
}

contextBridge.exposeInMainWorld('bluely', api)
