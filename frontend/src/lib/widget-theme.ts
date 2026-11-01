const THEME_ATTRIBUTE = 'data-easy-media-color-scheme'

/** Keep widget and body-portal colors in sync with the host palette. */
export function installWidgetTheme(): () => void {
  const root = document.documentElement
  const previousTheme = root.getAttribute(THEME_ATTRIBUTE)

  const syncTheme = () => {
    // Frontend 1.59+ sets color-scheme instead of the legacy theme class.
    const scheme = getComputedStyle(root).colorScheme.trim()
    const isDark = scheme === 'dark' || (
      scheme !== 'light'
      && (root.matches('.dark-theme, .dark') || document.body.matches('.dark-theme, .dark'))
    )
    const theme = isDark ? 'dark' : 'light'
    if (root.getAttribute(THEME_ATTRIBUTE) !== theme) {
      root.setAttribute(THEME_ATTRIBUTE, theme)
    }
  }

  const observer = new MutationObserver(syncTheme)
  observer.observe(root, { attributes: true, attributeFilter: ['style', 'class'] })
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] })
  syncTheme()

  return () => {
    observer.disconnect()
    if (previousTheme === null) root.removeAttribute(THEME_ATTRIBUTE)
    else root.setAttribute(THEME_ATTRIBUTE, previousTheme)
  }
}
