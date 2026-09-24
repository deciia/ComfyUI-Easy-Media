import * as React from "react"
import { createPortal } from "react-dom"

import { cn } from "@/lib/utils"
import { CUSTOM_NODE_CLASS } from "@/lib/constants"

/**
 * Lightweight tooltip primitives.
 *
 * These keep the exact same public API as the previous Radix-based wrapper
 * (Tooltip / TooltipTrigger / TooltipContent / TooltipProvider), but render
 * without @radix-ui/react-tooltip.
 *
 * Why: on ComfyUI frontend >= 1.53 (React 19) the Radix implementation
 * mounted a Presence per tooltip. Radix composes refs whose cleanup calls
 * setState, so whenever a tooltip-bearing subtree was torn down React ran
 * those setters from inside commitDeletionEffectsOnFiber (`safelyDetachRef`).
 * React 19 counts those as nested updates; with the 100+ tooltips the
 * multitrack editor renders, the counter hit its cap and aborted the whole
 * mount with error #185 (Maximum update depth exceeded) — leaving the widget
 * body blank.
 *
 * Behaviour is unchanged for users: hover/focus shows the same styled label.
 */

type Side = "top" | "right" | "bottom" | "left"

interface TooltipContextValue {
  open: boolean
  setOpen: (next: boolean) => void
  triggerRef: React.MutableRefObject<HTMLElement | null>
}

const TooltipContext = React.createContext<TooltipContextValue | null>(null)

interface TooltipProviderProps {
  children?: React.ReactNode
  delayDuration?: number
  skipDelayDuration?: number
  disableHoverableContent?: boolean
}

/** Kept for API compatibility; the lightweight tooltip needs no provider. */
const TooltipProvider = ({ children }: TooltipProviderProps) => <>{children}</>
TooltipProvider.displayName = "TooltipProvider"

interface TooltipProps {
  children?: React.ReactNode
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  delayDuration?: number
}

const Tooltip = ({ children, open, defaultOpen, onOpenChange }: TooltipProps) => {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false)
  const isControlled = open !== undefined
  const actualOpen = isControlled ? open : uncontrolledOpen
  const triggerRef = React.useRef<HTMLElement | null>(null)

  // Stable setter: children keep it in dependency arrays.
  const onOpenChangeRef = React.useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange

  const setOpen = React.useCallback(
    (next: boolean) => {
      setUncontrolledOpen(next)
      onOpenChangeRef.current?.(next)
    },
    [],
  )

  const value = React.useMemo<TooltipContextValue>(
    () => ({ open: actualOpen, setOpen, triggerRef }),
    [actualOpen, setOpen],
  )

  return <TooltipContext.Provider value={value}>{children}</TooltipContext.Provider>
}
Tooltip.displayName = "Tooltip"

interface TooltipTriggerProps extends React.HTMLAttributes<HTMLElement> {
  asChild?: boolean
  children?: React.ReactNode
}

const TooltipTrigger = React.forwardRef<HTMLElement, TooltipTriggerProps>(
  ({ asChild, children, ...props }, forwardedRef) => {
    const context = React.useContext(TooltipContext)

    const setRefs = React.useCallback(
      (node: HTMLElement | null) => {
        if (context) context.triggerRef.current = node
        if (typeof forwardedRef === "function") forwardedRef(node)
        else if (forwardedRef) (forwardedRef as React.MutableRefObject<HTMLElement | null>).current = node
      },
      [context, forwardedRef],
    )

    const handlers = {
      onMouseEnter: (event: React.MouseEvent<HTMLElement>) => {
        context?.setOpen(true)
        props.onMouseEnter?.(event)
      },
      onMouseLeave: (event: React.MouseEvent<HTMLElement>) => {
        context?.setOpen(false)
        props.onMouseLeave?.(event)
      },
      onFocus: (event: React.FocusEvent<HTMLElement>) => {
        context?.setOpen(true)
        props.onFocus?.(event)
      },
      onBlur: (event: React.FocusEvent<HTMLElement>) => {
        context?.setOpen(false)
        props.onBlur?.(event)
      },
    }

    if (asChild && React.isValidElement(children)) {
      const child = children as React.ReactElement<Record<string, unknown>>
      return React.cloneElement(child, {
        ...props,
        ...handlers,
        ref: setRefs,
      })
    }

    return (
      <span ref={setRefs} {...props} {...handlers}>
        {children}
      </span>
    )
  },
)
TooltipTrigger.displayName = "TooltipTrigger"

interface TooltipContentProps extends React.HTMLAttributes<HTMLDivElement> {
  side?: Side
  sideOffset?: number
  align?: string
  alignOffset?: number
  avoidCollisions?: boolean
  collisionPadding?: number
  forceMount?: boolean
  container?: HTMLElement | null
  sticky?: string
  hidden?: boolean
  updatePositionStrategy?: string
}

const TooltipContent = React.forwardRef<HTMLDivElement, TooltipContentProps>(
  ({ className, side = "top", sideOffset = 4, children, style, ...props }, forwardedRef) => {
    const context = React.useContext(TooltipContext)
    const [position, setPosition] = React.useState<{ top: number; left: number } | null>(null)

    const open = context?.open ?? false

    React.useEffect(() => {
      if (!open) {
        setPosition(null)
        return
      }
      const rect = context?.triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const offset = sideOffset
      let top = rect.top
      let left = rect.left + rect.width / 2
      if (side === "top") top = rect.top - offset
      else if (side === "bottom") top = rect.bottom + offset
      else if (side === "left") {
        top = rect.top + rect.height / 2
        left = rect.left - offset
      } else {
        top = rect.top + rect.height / 2
        left = rect.right + offset
      }
      setPosition({ top, left })
    }, [open, side, sideOffset, context])

    if (!open || !position) return null

    const transform =
      side === "top"
        ? "translate(-50%, -100%)"
        : side === "bottom"
          ? "translate(-50%, 0)"
          : side === "left"
            ? "translate(-100%, -50%)"
            : "translate(0, -50%)"

    return createPortal(
      <div className={CUSTOM_NODE_CLASS} style={{ position: "fixed", zIndex: 9999 }}>
        <div
          ref={forwardedRef}
          role="tooltip"
          className={cn(
            "z-50 overflow-hidden rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground",
            className,
          )}
          style={{
            position: "fixed",
            top: position.top,
            left: position.left,
            transform,
            pointerEvents: "none",
            ...style,
          }}
          {...props}
        >
          {children}
        </div>
      </div>,
      document.body,
    )
  },
)
TooltipContent.displayName = "TooltipContent"

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
