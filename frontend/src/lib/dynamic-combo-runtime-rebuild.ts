import type { ComfyApp } from '@comfyorg/comfyui-frontend-types'

/**
 * Runtime sub-widget rebuild for COMFY_DYNAMICCOMBO_V3 inputs.
 *
 * ComfyUI frontend 1.53+ (React 19 / new LiteGraph) builds the sub-widget set
 * once at node creation using the schema's default key, and never rebuilds it
 * when the selected key changes — neither on workflow load (handled by
 * track-data-realign.ts) nor at runtime when the user picks another option in
 * the combo. Symptom: switching "resolution" to "width x height (megapixels)"
 * shows no aspect_ratio / megapixels fields, and stale sub-widgets from the
 * previous key (e.g. resize_method) remain visible.
 *
 * Fix (display layer only): watch the dynamic-combo widget's value; when the
 * key changes, remove the old key's sub-widgets and add the new key's
 * sub-widgets from the node definition schema, then restore values that the
 * workflow had saved for them. No values are invented — defaults come from
 * the schema, saved values from the serialized node.
 */

interface SerializedWidgetLike {
  name: string
  type?: string
  value?: unknown
  setValue?: (v: unknown, ctx?: unknown) => void
  serializeValue?: () => unknown
  onRemove?: () => void
  options?: Record<string, unknown>
}

interface NodeLike {
  id: string | number
  widgets?: SerializedWidgetLike[]
  addWidget?: (
    type: string,
    name: string,
    value: unknown,
    callback?: unknown,
    options?: Record<string, unknown>,
  ) => SerializedWidgetLike
  removeWidget?: (widget: SerializedWidgetLike) => void
  onWidgetChanged?: (name: string, value: unknown, oldValue: unknown) => void
  setDirtyCanvas?: (force?: boolean) => void
  onRemoved?: () => void
  onConfigure?: (serialisedNode: unknown) => void
}

interface DynamicComboOption {
  key: string
  inputs?: {
    required?: Record<string, unknown[]>
    optional?: Record<string, unknown[]>
  }
}

interface NodeDefLike {
  input?: {
    required?: Record<string, unknown[]>
    optional?: Record<string, unknown[]>
  }
}

const WATCHED_NODES = new Set([
  'easy multiTrackEditor',
  'easy multitrackProject',
  'easy multitrackProjectVideoC',
])

/** Prefix identifying sub-widgets of the dynamic combo named `comboName`. */
function subWidgetPrefix(comboName: string): string {
  return `${comboName}.`
}

/** Extract the dynamic-combo schema (options list) for `comboName`. */
function dynamicComboOptions(nodeData: NodeDefLike, comboName: string): DynamicComboOption[] {
  const spec =
    nodeData.input?.required?.[comboName] ?? nodeData.input?.optional?.[comboName]
  if (!Array.isArray(spec) || spec.length < 2) return []
  const meta = spec[1] as { options?: DynamicComboOption[] } | undefined
  return Array.isArray(meta?.options) ? (meta.options as DynamicComboOption[]) : []
}

interface SubWidgetSpec {
  name: string
  widgetType: string
  defaultValue: unknown
  options: Record<string, unknown>
}

/** Map a schema input spec ([type, meta]) to an addWidget() spec. */
function subWidgetSpecFromInput(name: string, spec: unknown[]): SubWidgetSpec | null {
  const rawType = spec[0]
  const meta = (spec[1] ?? {}) as Record<string, unknown>
  if (typeof rawType !== 'string') return null
  let widgetType: string
  let defaultValue: unknown
  const options: Record<string, unknown> = { ...(meta as object) }
  if (rawType === 'COMBO' || (Array.isArray(rawType) && rawType.every((v) => typeof v === 'string'))) {
    widgetType = 'combo'
    const values = Array.isArray(rawType)
      ? rawType
      : (meta.options as unknown[] | undefined) ?? (meta.default as unknown)
    if (Array.isArray(values)) options.values = values
    defaultValue = meta.default ?? (Array.isArray(values) ? values[0] : undefined)
  } else if (rawType === 'INT' || rawType === 'FLOAT') {
    widgetType = 'number'
    defaultValue = meta.default ?? (rawType === 'INT' ? 0 : 0.0)
  } else if (rawType === 'BOOLEAN') {
    widgetType = 'toggle'
    defaultValue = meta.default ?? false
  } else if (rawType === 'STRING') {
    widgetType = 'text'
    defaultValue = meta.default ?? ''
  } else {
    widgetType = rawType.toLowerCase()
    defaultValue = meta.default ?? ''
  }
  return { name, widgetType, defaultValue, options }
}

/** Sub-widget specs declared by the schema for the given combo key. */
function specsForKey(
  options: DynamicComboOption[],
  key: string,
): SubWidgetSpec[] {
  const entry = options.find((o) => o.key === key)
  const required = entry?.inputs?.required ?? {}
  return Object.entries(required)
    .map(([name, spec]) => subWidgetSpecFromInput(name, spec as unknown[]))
    .filter((s): s is SubWidgetSpec => s !== null)
}

export function installDynamicComboRuntimeRebuild(
  nodeType: { prototype: NodeLike } | object,
  nodeData: { name?: string } & NodeDefLike,
  _app: ComfyApp,
) {
  if (!nodeData.name || !WATCHED_NODES.has(nodeData.name)) return

  const comboNames = Object.keys({
    ...(nodeData.input?.required ?? {}),
    ...(nodeData.input?.optional ?? {}),
  }).filter((name) => {
    const spec =
      nodeData.input?.required?.[name] ?? nodeData.input?.optional?.[name]
    return Array.isArray(spec) && spec[0] === 'COMFY_DYNAMICCOMBO_V3'
  })
  if (comboNames.length === 0) return

  const proto = nodeType as { prototype: NodeLike }
  const originalOnConfigure = proto.prototype.onConfigure
  proto.prototype.onConfigure = function onConfigureComboRebuild(
    this: NodeLike,
    serialisedNode: unknown,
  ) {
    originalOnConfigure?.call(this, serialisedNode)

    for (const comboName of comboNames) {
      const prefix = subWidgetPrefix(comboName)
      const widget = (this.widgets ?? []).find((w) => w.name === comboName)
      if (!widget || typeof widget.setValue !== 'function') continue
      const options = dynamicComboOptions(nodeData as NodeDefLike, comboName)
      if (options.length === 0) continue

      // Remember the values the workflow saved for this combo's sub-widgets
      // so a runtime key switch can restore them when the key returns.
      const savedSubValues = new Map<string, unknown>()
      const recordSubValues = () => {
        for (const w of this.widgets ?? []) {
          if (w.name?.startsWith(prefix) && w.name !== comboName) {
            const current = typeof w.serializeValue === 'function' ? w.serializeValue() : w.value
            if (current !== undefined && current !== null) savedSubValues.set(w.name, current)
          }
        }
      }
      if (serialisedNode) {
        const serialised = serialisedNode as { widgets_values?: unknown }
        const collect = (v: unknown) => {
          if (Array.isArray(v)) v.forEach(collect)
          else if (typeof v === 'object' && v !== null && 'widgets_values' in v) {
            collect((v as { widgets_values?: unknown }).widgets_values)
          }
        }
        collect(serialised.widgets_values)
      }
      recordSubValues()

      const rebuildForKey = (key: string) => {
        const specs = specsForKey(options, key)
        const specNames = new Set(specs.map((s) => `${prefix}${s.name}`))
        const widgets = this.widgets ?? []
        // Remove stale sub-widgets of this combo that the new key does not declare.
        for (const w of [...widgets]) {
          if (w.name?.startsWith(prefix) && w.name !== comboName && !specNames.has(w.name)) {
            recordSubValuesInto(savedSubValues, w, prefix)
            this.removeWidget?.(w)
          }
        }
        // Add missing sub-widgets (after the combo itself, in schema order).
        const comboIndex = (this.widgets ?? []).findIndex((w) => w.name === comboName)
        let insertAt = comboIndex >= 0 ? comboIndex + 1 : (this.widgets ?? []).length
        for (const spec of specs) {
          const fullName = `${prefix}${spec.name}`
          if ((this.widgets ?? []).some((w) => w.name === fullName)) continue
          const saved = savedSubValues.get(fullName)
          const value = saved !== undefined ? saved : spec.defaultValue
          const created = this.addWidget?.(
            spec.widgetType,
            fullName,
            value,
            undefined,
            spec.options,
          )
          if (created) {
            // addWidget appends at the end; move it into position.
            const list = (this.widgets ?? [])
            const from = list.indexOf(created)
            if (from >= 0 && from !== insertAt) {
              list.splice(from, 1)
              list.splice(Math.min(insertAt, list.length), 0, created)
            }
            insertAt += 1
          }
        }
        this.setDirtyCanvas?.(true)
      }

      // Rebuild whenever the combo value changes (user interaction or API).
      const originalSetValue = widget.setValue.bind(widget)
      const setValueCtx = () => ({ e: undefined, node: this, canvas: { graph_mouse: [0, 0] } })
      widget.setValue = function runtimeRebuildSetValue(
        this: SerializedWidgetLike,
        v: unknown,
        ctx?: unknown,
      ) {
        const old = this.value
        const result = originalSetValue(v, ctx ?? setValueCtx())
        if (this.value !== old) {
          recordSubValuesInto(savedSubValues, widget, prefix) // no-op for the combo itself
          queueMicrotask(() => rebuildForKey(String(this.value)))
        }
        return result
      }
      widget.options = widget.options ?? {}
      ;(widget.options as { onValueChange?: unknown }).onValueChange = undefined

      // Also rebuild if the value was set directly (bypassing setValue).
      let lastKey = String(widget.value ?? '')
      const poll = window.setInterval(() => {
        const current = String(widget.value ?? '')
        if (current !== lastKey) {
          lastKey = current
          rebuildForKey(current)
        }
      }, 300)
      // Stop polling when the node is removed.
      const stop = () => window.clearInterval(poll)
      ;(this as unknown as { __comboRebuildStoppers?: Array<() => void> }).__comboRebuildStoppers ??= []
      ;(this as unknown as { __comboRebuildStoppers?: Array<() => void> }).__comboRebuildStoppers!.push(stop)
      if (!runtimeRebuildRemovalHookInstalled.has(nodeType)) {
        runtimeRebuildRemovalHookInstalled.add(nodeType)
        const origRemoved = proto.prototype.onRemoved
        proto.prototype.onRemoved = function onRemovedComboRebuild(this: NodeLike) {
          for (const fn of (this as unknown as { __comboRebuildStoppers?: Array<() => void> }).__comboRebuildStoppers ?? []) fn()
          origRemoved?.call(this)
        }
      }

      // Initial reconcile in case the saved key differs from what the
      // creation-time sub-widget set assumes (load path also patched by
      // track-data-realign; this catches direct .value assignments).
      const initialKey = String(widget.value ?? '')
      const initialSpecs = specsForKey(options, initialKey)
      const initialNames = new Set(initialSpecs.map((s) => `${prefix}${s.name}`))
      const mismatch = (this.widgets ?? []).some(
        (w) => w.name?.startsWith(prefix) && w.name !== comboName && !initialNames.has(w.name),
      ) || initialSpecs.some(
        (s) => !(this.widgets ?? []).some((w) => w.name === `${prefix}${s.name}`),
      )
      if (mismatch) queueMicrotask(() => rebuildForKey(initialKey))
    }
  }
}

const runtimeRebuildRemovalHookInstalled = new WeakSet<object>()

function recordSubValuesInto(
  map: Map<string, unknown>,
  widget: SerializedWidgetLike,
  prefix: string,
) {
  if (!widget.name?.startsWith(prefix)) return
  const current = typeof widget.serializeValue === 'function' ? widget.serializeValue() : widget.value
  if (current !== undefined && current !== null) map.set(widget.name, current)
}
