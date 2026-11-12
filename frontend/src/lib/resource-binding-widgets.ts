/**
 * 资源采集器：折叠 ComfyTV 绑定控件（image1..9 / video1..3 / audio1..3）。
 *
 * 这些 STRING 控件带 image_upload / video_upload / audio_upload 标记，作用是让 ComfyTV
 * 侧栏把每一行渲染成「绑定素材」的行；在 ComfyUI 画布里它们没有存在意义，直接折叠掉，
 * 只保留面板三区。
 */

const BINDING_WIDGET_RE = /^(image[1-9]|video[1-3]|audio[1-3])$/

const RESOURCE_NODE_NAME = 'easy resourceCollector'

type NodeLike = {
  widgets?: Array<any>
  size?: [number, number]
  setSize?: (size: [number, number]) => void
}

export function collapseResourceBindingWidgets(nodeType: any, nodeData: any) {
  if (nodeData?.name !== RESOURCE_NODE_NAME) return

  const onNodeCreated = nodeType.prototype.onNodeCreated
  nodeType.prototype.onNodeCreated = function (this: NodeLike) {
    const result = onNodeCreated?.apply(this, arguments as any)
    for (const widget of this.widgets ?? []) {
      if (!BINDING_WIDGET_RE.test(String(widget?.name ?? ''))) continue
      widget.hidden = true
      widget.computeSize = () => [0, -4]
      if (widget.element) widget.element.style.display = 'none'
      if (widget.inputEl) widget.inputEl.style.display = 'none'
    }
    // 注意：不要在这里搬动 widget 顺序。
    // LiteGraph 的 widgets_values 是按 widget 顺序「按位置」序列化/还原的，
    // 把 media_data 提前会让整串值旋转一格（prompt 抢到面板槽、fast 参数串到绑定行）。
    // 面板在 schema 里排最后（受 ComfyTV 转换器丢弃自定义控件的约束），
    // 中间的 15 行绑定在画布上被隐藏，所以面板实际紧跟在时长之后显示。
    if (typeof this.setSize === 'function') {
      const width = Math.max(Number(this.size?.[0] ?? 0) || 0, 400)
      const height = Math.max(Number(this.size?.[1] ?? 0) || 0, 980)
      this.setSize([width, height])
    }
    return result
  }
}

/* ── 动态槽位：只显示「用到的那一个 + 一个空位」 ───────────────────────── */

const SLOT_GROUP_PREFIXES = ['images.image', 'videos.video', 'audio.audio'] as const

const SLOT_GROUP_LIMITS: Record<string, number> = {
  'images.image': 9,
  'videos.video': 3,
  'audio.audio': 3,
}

const SLOT_GROUP_TYPES: Record<string, string> = {
  'images.image': 'IMAGE',
  'videos.video': 'VIDEO',
  'audio.audio': 'AUDIO',
}

function groupOf(inputName: unknown): { prefix: string; index: number } | null {
  const name = String(inputName ?? '')
  for (const prefix of SLOT_GROUP_PREFIXES) {
    if (!name.startsWith(prefix)) continue
    const rest = name.slice(prefix.length)
    if (!/^\d+$/.test(rest)) continue
    return { prefix, index: Number(rest) }
  }
  return null
}

function syncResourceSlots(node: any) {
  const inputs: any[] = Array.isArray(node?.inputs) ? node.inputs : []
  if (!inputs.length) return
  for (const prefix of SLOT_GROUP_PREFIXES) {
    const limit = SLOT_GROUP_LIMITS[prefix] ?? 0
    let slots = inputs.filter((input) => groupOf(input?.name)?.prefix === prefix)
    if (!slots.length) continue

    let highestConnected = -1
    for (const input of slots) {
      const info = groupOf(input?.name)
      if (info && input?.link != null) highestConnected = Math.max(highestConnected, info.index)
    }
    const desired = Math.min(limit, Math.max(1, highestConnected + 1))

    // 从尾部裁掉未连接的槽
    while (slots.length > desired) {
      const last = slots[slots.length - 1]
      if (last?.link != null) break
      const index = inputs.indexOf(last)
      if (index < 0 || typeof node.removeInput !== 'function') break
      node.removeInput(index)
      slots.pop()
    }

    // 不足则补一个空槽，方便继续接线
    while (slots.length < desired) {
      const nextIndex = slots.length
      if (typeof node.addInput !== 'function') break
      const added = node.addInput(`${prefix}${nextIndex}`, SLOT_GROUP_TYPES[prefix])
      if (!added) break
      slots.push(added)
    }
  }
  node.setDirtyCanvas?.(true, true)
}

export function installResourceDynamicSlots(nodeType: any, nodeData: any) {
  if (nodeData?.name !== RESOURCE_NODE_NAME) return
  if (nodeType.prototype.__easyMediaResourceSlotsInstalled) return
  nodeType.prototype.__easyMediaResourceSlotsInstalled = true

  const wrap = (method: string) => {
    const original = nodeType.prototype[method]
    nodeType.prototype[method] = function (this: any) {
      const result = original?.apply(this, arguments as any)
      window.setTimeout(() => syncResourceSlots(this), 0)
      return result
    }
  }
  wrap('onNodeCreated')
  wrap('onConfigure')
  wrap('onConnectionsChange')
}
