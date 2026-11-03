/**
 * OmniCam 官方节点面板接管工具。
 *
 * 思路与 3D 视口一致：官方节点用 addDOMWidget 注册自己的面板 DOM，
 * 我们把它整块搬进弹窗容器，官方 UI 原样使用（含官方更新）。
 */

export type ComfyGraphLike = {
  _nodes?: Array<Record<string, unknown>>
  add?: (node: unknown) => void
  connect?: (source: unknown, sourceSlot: number, target: unknown, targetSlot: number) => unknown
  setDirtyCanvas?: (a: boolean, b: boolean) => void
}

export type ComfyAppLike = {
  graph?: ComfyGraphLike
  canvas?: {
    graph?: ComfyGraphLike
    setDirty?: (a: boolean, b: boolean) => void
    centerOnNode?: (node: unknown) => void
  }
  rootGraphInternal?: ComfyGraphLike
}

export type LiteGraphLike = {
  createNode?: (type: string) => Record<string, unknown> | null
}

export function resolveComfyGraph(): {
  app: ComfyAppLike | undefined
  graph: ComfyGraphLike | undefined
  liteGraph: LiteGraphLike | undefined
} {
  const registry = globalThis as unknown as {
    comfyAPI?: { app?: { app?: ComfyAppLike }; litegraph?: { LiteGraph?: LiteGraphLike } }
    app?: ComfyAppLike
    LiteGraph?: LiteGraphLike
  }
  const app = registry.comfyAPI?.app?.app ?? registry.app
  const graph = app?.rootGraphInternal ?? app?.canvas?.graph ?? app?.graph
  const liteGraph = registry.LiteGraph ?? registry.comfyAPI?.litegraph?.LiteGraph
  return { app, graph, liteGraph }
}

export function findNodeByType(graph: ComfyGraphLike | undefined, type: string): Record<string, unknown> | null {
  return (graph?._nodes ?? []).find(
    (item) => item.comfyClass === type || item.type === type,
  ) ?? null
}

export async function waitFor<T>(probe: () => T | null | undefined, timeoutMs = 6000, stepMs = 100): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = probe()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
  return probe() ?? null
}

/** 确保指定类型的节点存在（不存在则创建并加入图） */
export async function ensureNode(
  type: string,
  options: { waitForDom?: (node: Record<string, unknown>) => HTMLElement | null; timeoutMs?: number } = {},
): Promise<{ node: Record<string, unknown>; graph: ComfyGraphLike; app: ComfyAppLike | undefined }> {
  const { app, graph, liteGraph } = resolveComfyGraph()
  if (!graph) throw new Error('找不到 ComfyUI 画布')
  let node = findNodeByType(graph, type)
  if (!node) {
    if (!liteGraph?.createNode) throw new Error(`无法创建节点：${type}（类型未注册）`)
    node = liteGraph.createNode(type)
    if (!node) throw new Error(`创建节点失败：${type}`)
    node.pos = [80, 80]
    graph.add?.(node)
  }
  if (options.waitForDom) {
    const dom = await waitFor(() => options.waitForDom?.(node as Record<string, unknown>) ?? null, options.timeoutMs ?? 6000)
    if (!dom) throw new Error(`节点 ${type} 的面板未就绪`)
  }
  return { node, graph, app }
}

export function getDomWidgetElement(node: Record<string, unknown>, widgetName: string): HTMLElement | null {
  const widgets = (node.widgets as Array<Record<string, unknown>> | undefined) ?? []
  const widget = widgets.find((item) => item.name === widgetName)
  if (!widget) return null
  const element = (widget.element ?? widget.el ?? widget.inputEl) as HTMLElement | null
  return element ?? null
}

export function setWidgetValue(node: Record<string, unknown>, name: string, value: unknown): boolean {
  const widgets = (node.widgets as Array<Record<string, unknown>> | undefined) ?? []
  const widget = widgets.find((item) => item.name === name)
  if (!widget) return false
  widget.value = value
  const callback = widget.callback as ((value: unknown) => void) | undefined
  try {
    callback?.(value)
  } catch {
    // 官方 widget 回调出错不影响后续操作
  }
  return true
}

/** 把元素搬进容器；返回可用于还原的现场 */
export function mountElement(element: HTMLElement, host: HTMLElement): { parent: HTMLElement | null; next: Node | null } {
  const snapshot = { parent: element.parentElement, next: element.nextSibling }
  element.style.width = '100%'
  element.style.height = '100%'
  element.style.minHeight = '0'
  element.style.overflow = 'auto'
  host.appendChild(element)
  return snapshot
}

export function restoreElement(element: HTMLElement, snapshot: { parent: HTMLElement | null; next: Node | null } | null): void {
  if (!snapshot?.parent) return
  try {
    snapshot.parent.insertBefore(element, snapshot.next)
    element.style.width = ''
    element.style.height = ''
    element.style.minHeight = ''
    element.style.overflow = ''
  } catch {
    // 节点可能已被删除，忽略
  }
}
