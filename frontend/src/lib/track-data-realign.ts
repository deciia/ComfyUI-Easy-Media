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
  setValue?: (v: string) => void
  serializeValue?: () => unknown
  element?: HTMLElement
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

      for (const widget of this.widgets ?? []) {
        if (!looksMisaligned(widget)) continue
        const recovered = candidates.find(looksLikeTrackDataJson)
        if (recovered !== undefined && recovered !== widget.value) {
          // ComfyUI 1.54's DOMWidgetImpl.setValue(value, { e, node, canvas })
          // destructures the second argument — always pass a context object.
          if (typeof widget.setValue === 'function') widget.setValue(recovered, {})
          else widget.value = recovered
        }
      }
    } catch (error) {
      console.error('[easymedia] widget value realignment failed:', error)
    }
  }
}
