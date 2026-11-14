/**
 * 「多轨项目」节点：让「显示/隐藏高级输入」真正改变节点高度。
 *
 * ComfyUI 只把高级控件从绘制里去掉，节点尺寸不动，所以收起后底部留白。
 * 这里做两件事：
 *   1) 接管高级控件的 computeSize：收起时返回 [0,-4]（不占高度），展开时还原；
 *   2) 在 onDrawForeground 里检测 node.showAdvanced 的变化，变化瞬间用
 *      computeSize() 设一次高度。只在这一刻改尺寸，手动拖动的高度不会被覆盖。
 */

const NODE_NAMES = new Set(['easy multitrackProject'])

const MIN_HEIGHT = 80

type AnyWidget = {
  options?: { advanced?: boolean }
  computeSize?: (width?: number) => [number, number]
  __easyOrigComputeSize?: (width?: number) => [number, number]
}

type HeightNode = {
  widgets?: AnyWidget[]
  size?: [number, number]
  showAdvanced?: boolean
  computeSize?: () => [number, number]
  setSize?: (size: [number, number]) => void
  setDirtyCanvas?: (a?: boolean, b?: boolean) => void
  onDrawForeground?: (...args: any[]) => void
  __easyAdvancedState?: boolean
}

export function syncAdvancedWidgetHeights(nodeType: any, nodeData: { name?: string }) {
  if (!NODE_NAMES.has(String(nodeData?.name ?? ''))) return

  const originalOnNodeCreated = nodeType.prototype.onNodeCreated
  nodeType.prototype.onNodeCreated = function (this: HeightNode & Record<string, any>) {
    const result = originalOnNodeCreated?.apply(this, arguments as any)
    if (this.__easyAdvancedState !== undefined) return result

    const patchWidget = (widget: AnyWidget) => {
      if (!widget?.options?.advanced) return
      if (widget.__easyOrigComputeSize) return
      const orig = widget.computeSize?.bind(widget)
      widget.__easyOrigComputeSize = orig
      widget.computeSize = (width?: number) => {
        if (!this.showAdvanced) return [0, -4]
        return orig ? orig(width) : [width ?? 0, 24]
      }
    }

    for (const widget of this.widgets ?? []) patchWidget(widget)
    // 动态控件（切换采样模式后新增的高级子控件）也要覆盖
    const originalAddWidget = (this as any).addWidget?.bind(this)
    if (originalAddWidget) {
      ;(this as any).addWidget = (type: any, name: string, value: any, callback?: any, options?: any) => {
        const widget = originalAddWidget(type, name, value, callback, options)
        patchWidget(widget as AnyWidget)
        return widget
      }
    }

    this.__easyAdvancedState = Boolean(this.showAdvanced)

    // 载入结算：收起状态下若保存的高度明显大于内容（上次展开时留下的空白），
    // 直接归位一次；这是唯一一次在载入时改高度。
    const settle = () => {
      if (!this.graph) return
      if (this.showAdvanced) return
      const computed = this.computeSize?.()
      const content = Array.isArray(computed) ? Math.max(MIN_HEIGHT, Number(computed[1]) || 0) : 0
      const current = Number(this.size?.[1] ?? 0)
      if (content > 0 && current - content > 40) {
        this.setSize?.([Number(this.size?.[0] ?? 0) || 300, content])
        this.setDirtyCanvas?.(true, true)
      }
    }
    globalThis.setTimeout?.(settle, 250)

    const originalDraw = this.onDrawForeground
    this.onDrawForeground = function (this: HeightNode, ...args: any[]) {
      originalDraw?.apply(this, args as any)
      const state = Boolean(this.showAdvanced)
      if (state === this.__easyAdvancedState) return
      this.__easyAdvancedState = state
      const computed = this.computeSize?.()
      const target = Array.isArray(computed) ? Math.max(MIN_HEIGHT, Number(computed[1]) || 0) : null
      if (!target) return
      const width = Number(this.size?.[0] ?? 0) || 300
      this.setSize?.([width, target])
      this.setDirtyCanvas?.(true, true)
    }

    return result
  }
}
