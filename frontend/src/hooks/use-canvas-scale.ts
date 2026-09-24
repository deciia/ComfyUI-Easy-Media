import { useSyncExternalStore } from 'react'
import type { ComfyApp } from '@comfyorg/comfyui-frontend-types'

type DrawForeground = NonNullable<ComfyApp['canvas']['onDrawForeground']>

interface CanvasScaleStore {
  listeners: Set<() => void>
  scale: number
  installed: boolean
  origDraw: DrawForeground | null
}

/**
 * Shared canvas-scale store.
 *
 * Historically each widget instance monkey-patched `canvas.onDrawForeground`
 * and called setState synchronously inside the LiteGraph draw callback.
 * With React 18/19 concurrent rendering this is a nested-update hazard:
 * every canvas frame could schedule a render, and several stacked widget
 * patches fed React error #185 (Maximum update depth exceeded) as soon as
 * two EasyMedia widgets shared one graph.
 *
 * Now a single module-level subscription owns the draw hook. React widgets
 * subscribe through useSyncExternalStore, which only re-renders when the
 * snapshot (the scale number) actually changes.
 */
const store: CanvasScaleStore = {
  listeners: new Set(),
  scale: 1,
  installed: false,
  origDraw: null,
}

function publish(scale: number) {
  if (store.scale === scale) return
  store.scale = scale
  for (const listener of store.listeners) listener()
}

function installDrawHook(canvas: NonNullable<ComfyApp['canvas']>) {
  if (store.installed) return
  store.installed = true
  store.origDraw = canvas.onDrawForeground?.bind(canvas) ?? null
  canvas.onDrawForeground = ((...args: Parameters<DrawForeground>) => {
    store.origDraw?.(...args)
    // Read-only inside the draw loop: never call React setters here.
    publish(canvas.ds?.scale ?? 1)
  }) as DrawForeground
}

/** Overridable app accessor so tests can inject a fake ComfyApp. */
let appAccessor: () => ComfyApp | null | undefined = () =>
  (globalThis as { comfyAPI?: { app?: { app?: ComfyApp } } }).comfyAPI?.app?.app

export function setCanvasScaleAppAccessor(accessor: () => ComfyApp | null | undefined) {
  appAccessor = accessor
}

function currentApp(): ComfyApp | null | undefined {
  try {
    return appAccessor()
  } catch {
    return undefined
  }
}

function subscribe(listener: () => void): () => void {
  store.listeners.add(listener)
  const app = currentApp()
  if (app?.canvas) installDrawHook(app.canvas)

  return () => {
    store.listeners.delete(listener)
    if (store.listeners.size === 0 && store.installed) {
      // Restore the pristine callback only when nobody is listening; a
      // later widget re-installs it. This keeps the patch stack flat (max
      // depth 1) no matter how many widgets mount/unmount.
      const app2 = currentApp()
      if (app2?.canvas) {
        if (store.origDraw) {
          app2.canvas.onDrawForeground = store.origDraw
        } else {
          delete (app2.canvas as { onDrawForeground?: DrawForeground }).onDrawForeground
        }
      }
      store.installed = false
      store.origDraw = null
    }
  }
}

function getSnapshot(): number {
  return store.scale
}

function getServerSnapshot(): number {
  return 1
}

export function useCanvasScale(_app?: ComfyApp | null): number {
  void _app // kept for API compatibility; the store owns the app reference
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
