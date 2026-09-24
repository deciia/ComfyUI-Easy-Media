/**
 * Staggered initial render for EasyMedia React widget roots.
 *
 * When several EasyMedia React trees mount in the same synchronous task
 * (e.g. loading a workflow that contains both `easy multiTrackEditor` and
 * `easy multitrackProject`), each tree's ref-attach cascade (Radix Presence
 * setNode et al.) compounds into a single nested-update sequence. React 18/19
 * caps nested updates at 50; three trees at ~20 ref-driven updates each
 * crossed the cap and aborted the whole mount with React error #185
 * (Maximum update depth exceeded), leaving blank widget bodies.
 *
 * Mounting one root per animation frame keeps every cascade far below the
 * cap. This is display-layer scheduling only: same components, same props,
 * same values — the first paint of each widget shifts by at most a few frames.
 */
const queue: Array<() => void> = []
let scheduled = false

function pump(): void {
  scheduled = false
  const next = queue.shift()
  if (!next) return
  try {
    next()
  } finally {
    if (queue.length > 0) schedule()
  }
}

function schedule(): void {
  if (scheduled) return
  scheduled = true
  const raf = globalThis.requestAnimationFrame?.bind(globalThis)
  if (typeof raf === 'function') raf(() => pump())
  else globalThis.setTimeout?.(() => pump(), 0)
}

/** Queue a root's FIRST render; subsequent renders stay synchronous. */
export function scheduleInitialRender(fn: () => void): void {
  queue.push(fn)
  schedule()
}
