import { useEffect, useRef, useState } from 'react'
import {
  ensureNode,
  getDomWidgetElement,
  mountElement,
  restoreElement,
  waitFor,
  type ComfyGraphLike,
} from '@/lib/omnicam-embed'

interface EmbeddedNodePanelProps {
  /** 节点类型，例如 MajoorOmniCamExtractor */
  nodeType: string
  /** DOM widget 名称，例如 majoor_omnicam_extractor */
  widgetName: string
  /** 是否当前可见（页签切换时挂载/还原） */
  active: boolean
  /** 挂载前的准备（写入源、连线等） */
  prepare?: (node: Record<string, unknown>, graph: ComfyGraphLike) => void | Promise<void>
  /** 挂载完成 */
  onMounted?: (node: Record<string, unknown>) => void
  onError?: (message: string) => void
}

/**
 * 把 OmniCam 官方节点的 DOM 面板搬进弹窗。
 * 官方 UI 原样使用，不做任何仿制；关闭/切页签时还原。
 */
export function EmbeddedNodePanel({ nodeType, widgetName, active, prepare, onMounted, onError }: EmbeddedNodePanelProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const mountedRef = useRef<{ element: HTMLElement; parent: HTMLElement | null; next: Node | null } | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!active) return
    let cancelled = false
    void (async () => {
      try {
        const { node, graph } = await ensureNode(nodeType, {
          waitForDom: (item) => getDomWidgetElement(item, widgetName),
        })
        if (cancelled) return
        await prepare?.(node, graph)
        if (cancelled) return
        const element = await waitFor(() => getDomWidgetElement(node, widgetName), 4000)
        const host = hostRef.current
        if (!element || !host) throw new Error('官方面板尚未就绪')
        if (!mountedRef.current) {
          mountedRef.current = { element, ...mountElement(element, host) }
        } else if (element.parentElement !== host) {
          host.appendChild(element)
        }
        setReady(true)
        onMounted?.(node)
      } catch (error) {
        if (!cancelled) onError?.(error instanceof Error ? error.message : String(error))
      }
    })()
    return () => {
      cancelled = true
      const saved = mountedRef.current
      if (saved) {
        restoreElement(saved.element, saved)
        mountedRef.current = null
      }
      setReady(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, nodeType, widgetName])

  return (
    <div className="relative flex min-h-[520px] w-full flex-col">
      <div ref={hostRef} className="flex-1 overflow-auto rounded border border-border bg-background" />
      {ready ? null : (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground">
          正在载入官方面板…
        </div>
      )}
    </div>
  )
}
