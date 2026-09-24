import type { ComfyApp } from '@comfyorg/comfyui-frontend-types'

/**
 * Widget-value re-alignment for nodes whose schema mixes a
 * COMFY_DYNAMICCOMBO_V3 input (whose sub-widget set changes with the selected
 * key) with EasyMedia's serialized JSON widgets (TRACK_DATA / TIMELINE).
 *
 * Problem observed on ComfyUI frontend 1.54: when a workflow saved while the
 * dynamic combo had extra sub-widgets (e.g. `resolution.megapixels`) is
 * loaded, the sub-widget set is rebuilt and `widgets_values` — applied
 * positionally — shifts by the missing widget count. The JSON payload lands
 * on the wrong widget (e.g. track_data receives the format combo's string
 * "MiniMax"), JSON.parse fails, and the multitrack editor renders blank.
 *
 * Fix (display layer only): after `onConfigure`, if a serialized JSON widget
 * holds a value that is neither valid JSON of the expected shape nor empty,
 * scan the node's saved `widgets_values` for a valid JSON candidate and
 * restore it. Values are never invented — only recovered from what the
 * workflow itself saved.
 */

interface SerializedWidgetLike {
  name: string
  type?: string
  value?: unknown
  setValue?: (v: string, ctx?: unknown) => void
  serializeValue?: () => unknown
  element?: HTMLElement
}

interface ComboWidgetLike extends SerializedWidgetLike {
  type: 'combo'
  options?: { values?: unknown[] }
}

interface NodeLike {
  id: string | number
  widgets?: SerializedWidgetLike[]
  onConfigure?: (serialisedNode: unknown) => void
}

interface SerialisedNodeLike {
  widgets_values?: unknown
}

const JSON_WIDGET_TYPES = new Set(['react-widget', 'TRACK_DATA', 'TIMELINE'])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A candidate looks like our serialized widget JSON: object with a known top-level marker. */
function looksLikeTrackDataJson(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return false
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (!isPlainObject(parsed)) return false
    // TRACK_DATA / TIMELINE both serialize with a `tracks` array (TIMELINE
    // uses the same editor payload). Keep the check loose but meaningful.
    return Array.isArray(parsed.tracks) || 'timeline' in parsed
  } catch {
    return false
  }
}

function looksMisaligned(widget: SerializedWidgetLike): boolean {
  if (widget.type && !JSON_WIDGET_TYPES.has(widget.type)) return false
  const v = widget.value
  if (v === undefined || v === null || v === '') return false
  if (typeof v !== 'string') return false
  if (v.trim() === '') return false
  // Empty-ish defaults are fine.
  return !looksLikeTrackDataJson(v)
}

function flattenWidgetsValues(raw: unknown): string[] {
  const out: string[] = []
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (isPlainObject(v)) {
      // Legacy shape: { name: value } maps or { widgets_values: [...] }
      if ('widgets_values' in v) walk((v as { widgets_values?: unknown }).widgets_values)
    }
  }
  walk(raw)
  return out
}

function flattenNumberValues(raw: unknown): number[] {
  const out: number[] = []
  const walk = (v: unknown) => {
    if (typeof v === 'number') out.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (isPlainObject(v)) {
      if ('widgets_values' in v) walk((v as { widgets_values?: unknown }).widgets_values)
    }
  }
  walk(raw)
  return out
}

const ASPECT_RATIO_LABELS = new Set([
  '1:1 (Square)',
  '2:3 (Portrait Photo)',
  '3:2 (Photo)',
  '3:4 (Portrait Standard)',
  '4:3 (Standard)',
  '9:16 (Portrait Widescreen)',
  '16:9 (Widescreen)',
  '21:9 (Ultrawide)',
])

export function installTrackDataRealignment(nodeType: { prototype: NodeLike }, nodeData: { name?: string }, _app: ComfyApp) {
  const NODE_NAMES = new Set(['easy multiTrackEditor', 'easy multitrackProject', 'easy multitrackProjectVideoC'])
  if (!NODE_NAMES.has(nodeData.name || '')) return

  const originalOnConfigure = nodeType.prototype.onConfigure
  nodeType.prototype.onConfigure = function onConfigureRealigned(this: NodeLike, serialisedNode: unknown) {
    originalOnConfigure?.call(this, serialisedNode)

    try {
      const serialised = serialisedNode as SerialisedNodeLike | undefined
      if (!serialised?.widgets_values) return
      const candidates = flattenWidgetsValues(serialised.widgets_values)
      if (candidates.length === 0) return

      // ComfyUI 1.54's DOMWidgetImpl.setValue(value, ctx) destructures
      // { e, node, canvas } and reads canvas.graph_mouse + node callbacks —
      // an empty ctx throws. Build a minimal load-time context once.
      const setValueCtx = { e: undefined, node: this as unknown, canvas: { graph_mouse: [0, 0] } }
      const applyValue = (widget: SerializedWidgetLike, v: string) => {
        if (typeof widget.setValue === 'function') widget.setValue(v, setValueCtx)
        else widget.value = v
      }

      // Step 1: recover the JSON widget (TRACK_DATA/TIMELINE payload) into
      // whichever serialized JSON widget currently holds a non-JSON value.
      for (const widget of this.widgets ?? []) {
        if (!looksMisaligned(widget)) continue
        const recovered = candidates.find(looksLikeTrackDataJson)
        if (recovered !== undefined && recovered !== widget.value) {
          applyValue(widget, recovered)
        }
      }

      // Step 2: positional re-alignment for combo widgets that received a
      // value that is not one of their options (e.g. `format` got the
      // megapixels float 0.5, `resolution.resize_method` got the resolution
      // preset string). Walk the saved values in order and re-seat each
      // non-option value onto the first combo widget that does offer it.
      const combos = (this.widgets ?? []).filter(
        (w) => w.type === 'combo' && Array.isArray((w as ComboWidgetLike).options?.values),
      ) as ComboWidgetLike[]
      for (const widget of combos) {
        const opts: unknown[] = widget.options?.values ?? []
        const current = widget.value
        const currentOk = current === undefined || current === null
          ? false
          : (typeof current === 'string' ? opts.includes(current) : opts.includes(current as never))
        if (currentOk) continue
        // Find a saved value that is a valid option for this widget and is
        // not already correctly seated on an earlier combo.
        const match = candidates.find((c) => opts.includes(c as never) && !combos.some((o) => o.value === c))
        if (match !== undefined && match !== current) {
          applyValue(widget, match)
        }
        // Nothing in the saved values fits this combo (frontend 1.53+ never
        // rebuilt the DYNAMICCOMBO_V3 sub-widget set, so the slot that should
        // hold resize_method received the aspect-ratio preset string instead).
        // Reset it to its first option — never leave an invalid value behind
        // (ComfyUI paints those with the "bad value" red outline).
        const fallback = opts[0]
        if (match === undefined && fallback !== undefined) {
          applyValue(widget, String(fallback))
        }
      }

      // Step 3: the megapixels sub-value (a float like 0.5) was dropped by
      // the positional shift; reseat it so the backend receives the saved
      // resolution instead of the schema default. Deferred: ComfyUI 1.54
      // re-applies widgets_values asynchronously after onConfigure, which
      // would clobber a widget created synchronously here.
      const savedNumbers = flattenNumberValues(serialised.widgets_values)
      const resolutionWidget = (this.widgets ?? []).find((w) => w.name === 'resolution')
      const resolutionKey = typeof resolutionWidget?.value === 'string' ? resolutionWidget.value : ''
      if (resolutionKey.includes('megapixels')) {
        const self = this
        const applyDeferred = () => {
          try {
            const widgets = self.widgets ?? []
            let aspectWidget = widgets.find((w) => w.name === 'resolution.aspect_ratio')
            let megaWidget = widgets.find((w) => w.name === 'resolution.megapixels')
            // Recover the aspect ratio from the saved preset string (it was
            // squatted on resize_method before Step 2 reset it).
            const aspect = candidates.find((c) => ASPECT_RATIO_LABELS.has(c))
            if (!aspectWidget && aspect && typeof (self as unknown as { addWidget?: unknown }).addWidget === 'function') {
              const addWidget = (self as unknown as { addWidget: (t: string, n: string, v: string, opts?: unknown) => SerializedWidgetLike }).addWidget
              aspectWidget = addWidget.call(self, 'combo', 'resolution.aspect_ratio', aspect, { values: [...ASPECT_RATIO_LABELS] }) as ComboWidgetLike | undefined
            }
            if (!megaWidget && typeof (self as unknown as { addWidget?: unknown }).addWidget === 'function') {
              const addWidget = (self as unknown as { addWidget: (t: string, n: string, v: number, opts?: unknown) => SerializedWidgetLike }).addWidget
              megaWidget = addWidget.call(self, 'number', 'resolution.megapixels', 1.0, {})
            }
            if (aspect && aspectWidget && aspectWidget.value !== aspect) {
              applyValue(aspectWidget, aspect)
            }
            if (megaWidget) {
              const megaValue = savedNumbers.find((n) => n > 0 && n <= 16)
              const want = megaValue !== undefined ? megaValue : 1.0
              if (megaWidget.value !== want) applyValue(megaWidget, String(want))
            }
          } catch (error) {
            console.error('[easymedia] deferred megapixels restore failed:', error)
          }
        }
        setTimeout(applyDeferred, 120)
      }
    } catch (error) {
      console.error('[easymedia] widget value realignment failed:', error)
    }
  }
}
