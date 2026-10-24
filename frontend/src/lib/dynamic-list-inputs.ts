/**
 * 让 easy makeImageList / makeAudioList / makeVideoList 的输入插槽随连接动态增减：
 * 只保留「已连接的最大序号 + 1」个槽位（至少 1 个、最多 10 个）。
 * 纯前端行为，不改后端 schema；移除的都是尾部未连接的可选槽，不影响已存连线的索引。
 */
type SlotSpec = { prefix: string; max: number; type: string }

const SLOT_SPECS: Record<string, SlotSpec> = {
  'easy makeImageList': { prefix: 'image', max: 10, type: 'IMAGE' },
  'easy makeAudioList': { prefix: 'audio', max: 10, type: 'AUDIO' },
  'easy makeVideoList': { prefix: 'video', max: 10, type: 'VIDEO' },
}

export function installDynamicListInputs(nodeType: any, nodeData: { name?: string }) {
  const spec = SLOT_SPECS[String(nodeData?.name ?? '')]
  if (!spec || !nodeType?.prototype) return
  if (nodeType.prototype.__easyMediaDynamicListInstalled) return
  nodeType.prototype.__easyMediaDynamicListInstalled = true

  const slotNumberOf = (name: unknown): number => {
    const match = new RegExp(`^${spec.prefix}(\\d+)$`).exec(String(name ?? ''))
    return match ? Number(match[1]) : -1
  }

  const listSlots = (node: any): any[] => (node?.inputs ?? []).filter((input: any) => slotNumberOf(input?.name) > 0)

  const sync = (node: any) => {
    const inputs: any[] = node?.inputs ?? []
    const slots = listSlots(node)
    if (!slots.length) return
    let highestConnected = 0
    for (const input of slots) {
      if (input?.link != null) highestConnected = Math.max(highestConnected, slotNumberOf(input.name))
    }
    const desired = Math.min(spec.max, Math.max(1, highestConnected + 1))

    // 先裁掉尾部多余且未连接的槽（从末尾往前，避免索引错位）
    while (slots.length > desired) {
      const last = slots[slots.length - 1]
      if (last?.link != null) break
      const index = inputs.indexOf(last)
      if (index < 0 || typeof node.removeInput !== 'function') break
      node.removeInput(index)
      slots.pop()
    }

    // 再补齐到 desired（始终保持一个空槽，方便继续接线）
    while (slots.length < desired) {
      const nextIndex = slots.length + 1
      if (typeof node.addInput !== 'function') break
      const added = node.addInput(`${spec.prefix}${nextIndex}`, spec.type)
      if (!added) break
      slots.push(added)
    }
    node.setDirtyCanvas?.(true, true)
  }

  const originalCreated = nodeType.prototype.onNodeCreated
  nodeType.prototype.onNodeCreated = function (...args: any[]) {
    const result = originalCreated?.apply(this, args)
    window.setTimeout(() => sync(this), 0)
    return result
  }

  const originalConfigure = nodeType.prototype.onConfigure
  nodeType.prototype.onConfigure = function (...args: any[]) {
    const result = originalConfigure?.apply(this, args)
    window.setTimeout(() => sync(this), 0)
    return result
  }

  const originalConnectionsChange = nodeType.prototype.onConnectionsChange
  nodeType.prototype.onConnectionsChange = function (...args: any[]) {
    const result = originalConnectionsChange?.apply(this, args)
    window.setTimeout(() => sync(this), 0)
    return result
  }
}
