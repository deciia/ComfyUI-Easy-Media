import type { ReactNode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MultiTrackSegmentBlock } from '@/components/widgets/multitrack/MultiTrackSegmentBlock'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { MultiTrackSegment, MultiTrackReferenceMode } from '@/types/multitrack'

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
  ContextMenuSub: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuSubTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuSubContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver

const audioSegment: MultiTrackSegment = {
  id: 'audio-segment',
  start_frame: 0,
  end_frame: 5,
  color: 'var(--primary)',
  content: { media_type: 'audio' },
}

function renderBlock(mode: MultiTrackReferenceMode, onChange = vi.fn()) {
  render(
    <TooltipProvider>
      <MultiTrackSegmentBlock
        trackType="audio"
        segmentIndex={0}
        segment={audioSegment}
        totalLength={1000}
        frameRate={24}
        areaWidth={20}
        canvasScale={1}
        selected
        onSelect={vi.fn()}
        onDelete={vi.fn()}
        onResize={vi.fn()}
        onResizePreview={vi.fn()}
        onMove={vi.fn()}
        referenceMode={mode}
        onReferenceModeChange={onChange}
      />
    </TooltipProvider>,
  )
  return onChange
}

describe('reference scope badge', () => {
  it('cycles off -> aligned -> global -> off', () => {
    let onChange = renderBlock('off')
    fireEvent.click(screen.getByTestId('audio-shared-reference'))
    expect(onChange).toHaveBeenLastCalledWith('aligned')

    onChange = renderBlock('aligned')
    fireEvent.click(screen.getAllByTestId('audio-shared-reference').at(-1)!)
    expect(onChange).toHaveBeenLastCalledWith('global')

    onChange = renderBlock('global')
    fireEvent.click(screen.getAllByTestId('audio-shared-reference').at(-1)!)
    expect(onChange).toHaveBeenLastCalledWith('off')
  })

  it('exposes the current mode on the badge for styling/tests', () => {
    renderBlock('aligned')
    expect(screen.getByTestId('audio-shared-reference').getAttribute('data-reference-mode')).toBe('aligned')
  })
})
