import { afterEach, describe, expect, it, vi } from 'vitest'
import { installWidgetTheme } from '@/lib/widget-theme'

const attribute = 'data-easy-media-color-scheme'
let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.documentElement.removeAttribute('style')
  document.documentElement.removeAttribute('class')
  document.documentElement.removeAttribute(attribute)
  document.body.removeAttribute('class')
  document.body.replaceChildren()
})

describe('widget theme compatibility', () => {
  it('detects frontend 1.59 dark mode without a dark-theme class, including body portals', () => {
    document.documentElement.style.colorScheme = 'dark'
    const widget = document.createElement('div')
    const portal = document.createElement('div')
    widget.className = portal.className = 'comfyui-easy-media'
    document.body.append(widget, portal)
    dispose = installWidgetTheme()

    expect(document.documentElement.getAttribute(attribute)).toBe('dark')
    expect(widget.matches(`[${attribute}="dark"] .comfyui-easy-media`)).toBe(true)
    expect(portal.matches(`[${attribute}="dark"] .comfyui-easy-media`)).toBe(true)
  })

  it('updates the shared theme when switching palettes', async () => {
    document.documentElement.style.colorScheme = 'dark'
    dispose = installWidgetTheme()
    document.documentElement.style.colorScheme = 'light'
    await vi.waitFor(() => {
      expect(document.documentElement.getAttribute(attribute)).toBe('light')
    })
    document.documentElement.style.colorScheme = 'dark'
    await vi.waitFor(() => {
      expect(document.documentElement.getAttribute(attribute)).toBe('dark')
    })
  })

  it.each(['dark-theme', 'dark'])('supports the legacy %s class and switching to light', async (themeClass) => {
    document.body.classList.add(themeClass)
    dispose = installWidgetTheme()
    expect(document.documentElement.getAttribute(attribute)).toBe('dark')
    document.body.classList.remove(themeClass)
    await vi.waitFor(() => {
      expect(document.documentElement.getAttribute(attribute)).toBe('light')
    })
  })

  it('uses an explicit host color scheme ahead of legacy classes', () => {
    document.body.classList.add('dark-theme')
    document.documentElement.style.colorScheme = 'light'
    dispose = installWidgetTheme()
    expect(document.documentElement.getAttribute(attribute)).toBe('light')
  })

  it('stops observing and restores the previous attribute on disposal', async () => {
    document.documentElement.setAttribute(attribute, 'dark')
    document.documentElement.style.colorScheme = 'dark'
    dispose = installWidgetTheme()
    dispose()
    dispose = undefined
    document.documentElement.style.colorScheme = 'light'
    await Promise.resolve()
    expect(document.documentElement.getAttribute(attribute)).toBe('dark')
  })
})
