import React from 'react'
import { createRoot, Root } from 'react-dom/client'
import { CUSTOM_NODE_CLASS } from './constants'
import { scheduleInitialRender } from './staggered-mount'
import type {
  ComfyApp,
  DOMWidget,
  DOMWidgetOptions,
  InputSpec,
} from '@comfyorg/comfyui-frontend-types'

/**
 * Structural interface for the subset of LGraphNode methods we use.
 * LGraphNode is not exported from @comfyorg/comfyui-frontend-types, so we
 * declare only what we need and cast to this type inside the factory.
 */
interface ComfyNode {
  setDirtyCanvas(fg: boolean, bg?: boolean): void
  addDOMWidget<T extends HTMLElement, V extends object | string>(
    name: string,
    type: string,
    element: T,
    options?: DOMWidgetOptions<V>,
  ): DOMWidget<T, V>
}

/** ComfyUI adds serializeValue to DOM widgets at runtime. */
type ComfyDOMWidget<T extends HTMLElement, V extends object | string> =
  DOMWidget<T, V> & { serializeValue?: () => V }

export interface ReactWidgetProps<T extends object | string = object> {
  value: T
  onChange: (value: T) => void
  /** The input name as declared in the node schema */
  inputName: string
  /** The LGraphNode instance this widget belongs to */
  node: any
  /** The DOMWidget instance for this widget */
  widget: DOMWidget<HTMLDivElement, string>
  /** The ComfyApp instance */
  app: ComfyApp
}

export interface ReactWidgetOptions {
  /** Default serialized value (JSON string) when the widget is first created */
  defaultValue?: string
  /** Custom height for the widget container in pixels */
  height?: number
  /** Keep this widget sized to its LiteGraph node despite legacy width writes. */
  keepResponsiveWidthInLiteGraph?: boolean
  /** Extra options merged into DOMWidgetOptions passed to addDOMWidget */
  domWidgetOptions?: Omit<DOMWidgetOptions<string>, 'getValue' | 'setValue'>
}

interface LiteGraphRuntime {
  vueNodesMode?: boolean
}

function isVueNodesMode(): boolean {
  const liteGraph = (globalThis as typeof globalThis & { LiteGraph?: LiteGraphRuntime }).LiteGraph
  return Boolean(liteGraph?.vueNodesMode)
}

function keepWidgetWidthResponsive(widget: DOMWidget<HTMLDivElement, string>) {
  let width = widget.width

  Object.defineProperty(widget, 'width', {
    configurable: true,
    enumerable: true,
    get: () => width,
    set: (nextWidth: number | undefined) => {
      if (isVueNodesMode()) width = nextWidth
    },
  })

  if (!isVueNodesMode()) width = undefined
}

/**
 * Creates a ComfyUI custom widget factory that renders a React component
 * inside a DOM widget slot.
 *
 * Usage in getCustomWidgets:
 *   return {
 *     TIMELINE: createReactWidget(TimelineWidget, { defaultValue: '' })
 *   }
 */
export function createReactWidget<T extends object | string = object>(
  Component: React.ComponentType<ReactWidgetProps<T>>,
  options: ReactWidgetOptions = {},
) {
  // node is typed as `any` so this function is assignable to ComfyWidgetConstructor
  // (LGraphNode is not exported from the package, and using a narrower structural
  //  type would break contravariant parameter compatibility).
  return function widgetFactory(
    node: any, // eslint-disable-line @typescript-eslint/no-explicit-any
    inputName: string,
    _inputData: InputSpec,
    _app: ComfyApp,
  ): { widget: DOMWidget<HTMLDivElement, string> } {
    // Always store the value as a JSON string so ComfyUI can serialize it directly.
    let currentValue: string = options.defaultValue ?? ''
    let root: Root | null = null

    const container = document.createElement('div')
    container.classList.add('comfyui-react-widget', CUSTOM_NODE_CLASS)
    if (options.height !== undefined) {
      container.style.height = `${options.height}px`
    }

    const comfyNode = node as ComfyNode

    // Stable value identity: cache the parsed object and reuse it while
    // currentValue is unchanged. A fresh JSON.parse per render gave React a
    // new object reference every time, defeating memo/effect deps.
    let parsedValue: T
    let parsedFrom: string | undefined

    function parseValue(): T {
      if (parsedFrom !== currentValue) {
        try {
          parsedValue = JSON.parse(currentValue) as T
        } catch {
          parsedValue = currentValue as unknown as T
        }
        parsedFrom = currentValue
      }
      return parsedValue
    }

    // Stable onChange identity across renders. MultiTrackWidget and friends
    // keep effects/callbacks keyed on [onChange]; a fresh arrow function per
    // render made those effects re-fire every render -> React #185
    // (Maximum update depth exceeded) on ComfyUI frontend >= 1.53.
    //
    // The value-equality short-circuit and microtask coalescing below matter
    // just as much: a child that reported an unchanged value used to trigger
    // a full root.render() from inside its own effect. Radix ref callbacks
    // then ran during React's commit/deletion pass (safelyDetachRef ->
    // composed ref -> setState), which React 19 counts as nested updates and
    // aborts at 50 with #185, blanking the widget.
    let renderScheduled = false

    function scheduleRender() {
      if (renderScheduled) return
      renderScheduled = true
      const flush = () => {
        renderScheduled = false
        render()
      }
      if (typeof queueMicrotask === 'function') queueMicrotask(flush)
      else Promise.resolve().then(flush)
    }

    function handleChange(v: T) {
      const next = typeof v === 'string' ? v : JSON.stringify(v)
      if (next === currentValue) return
      currentValue = next
      comfyNode.setDirtyCanvas(true, true)
      scheduleRender()
    }

    function render() {
      root?.render(
        React.createElement(Component, {
          value: parseValue(),
          onChange: handleChange,
          inputName,
          widget,
          node: comfyNode,
          app: _app,
        }),
      )
    }

    const widget = comfyNode.addDOMWidget<HTMLDivElement, string>(
      inputName,
      'react-widget',
      container,
      {
        getValue: () => currentValue,
        setValue: (v: string) => {
          currentValue = v
          render()
        },
        getMinHeight: () => 30,
        getMaxHeight: () => node.size[1],
        hideOnZoom: true,
        serialize: true,
        ...options.domWidgetOptions,
      },
    ) as ComfyDOMWidget<HTMLDivElement, string>

    if (options.keepResponsiveWidthInLiteGraph) {
      keepWidgetWidthResponsive(widget)
    }

    // Keep compatibility with node reloaders that only recognize string DOM
    // widgets through the legacy inputEl field.
    widget.inputEl = container

    // serializeValue is called by ComfyUI when building the API prompt payload
    widget.serializeValue = () => currentValue
    root = createRoot(container)
    // Stagger the first paint of each widget root across frames: several
    // roots mounting in one synchronous batch compound their ref-attach
    // cascades into React #185 (nested update cap). Subsequent renders
    // stay synchronous via render().
    render()

    return { widget }
  }
}
