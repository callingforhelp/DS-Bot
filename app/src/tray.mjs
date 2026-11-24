// The system tray: the way back to a hidden window and the one ordinary way out.

/**
 * @param {{
 *   Tray: new (image: object) => object,
 *   Menu: { buildFromTemplate: (template: object[]) => object },
 *   platform: string,
 *   image: object,
 *   tooltip: string,
 *   open: { label: string, run: () => void },
 *   quit: { label: string, run: () => void },
 *   computer?: { onAction: (kind: string, botId: string | null) => void, stopAll?: () => string },
 *   cliShim?: { label: string, run: () => void },
 *   log?: Pick<Console, 'warn'>,
 * }} options the mark, the tooltip and the entries of the menu
 * @returns {{ tray: object, relabel: () => void, setComputer: (entries: object[]) => void, setCliShim: (shim?: { label: string, run: () => void }) => void, setSwarmBadge: (alert?: { count?: number, label?: string }) => void, dispose: () => void }}
 */
export function createTray({ Tray, Menu, platform, image, tooltip, open, quit, computer, cliShim: initialCliShim, log = console }) {
  const tray = new Tray(image)
  let disposed = false
  let entries = []
  let cliShim = initialCliShim
  let swarmAlert = null

  const relabel = () => {
    let tip = tooltip
    if (swarmAlert?.label) {
      tip = `${tooltip} (${swarmAlert.label})`
    }
    tray.setToolTip(tip)

    if (platform === 'darwin' && typeof tray.setTitle === 'function') {
      if (swarmAlert?.count && swarmAlert.count > 0) {
        tray.setTitle(` ${swarmAlert.count}`)
      } else {
        tray.setTitle('')
      }
    }

    const rows = entries.map(entry => ({
      label: entry.label,
      click: () => { computer?.onAction('stop', entry.botId ?? null) },
    }))
    if (entries.length > 1) rows.push({
      label: computer?.stopAll?.() ?? 'Stop all', click: () => { computer?.onAction('stopall', null) },
    })

    const menuItems = [
      { label: open.label, click: () => { open.run() } },
    ]

    if (swarmAlert?.label) {
      menuItems.push({ label: `Swarm: ${swarmAlert.label}`, enabled: false })
    }

    if (cliShim) {
      menuItems.push({
        label: cliShim.label || 'Install dsbot-mem CLI',
        click: () => { cliShim.run() },
      })
    }

    if (rows.length > 0) {
      menuItems.push({ type: 'separator' }, ...rows)
    }

    menuItems.push({ type: 'separator' })
    menuItems.push({ label: quit.label, click: () => { quit.run() } })

    tray.setContextMenu(Menu.buildFromTemplate(menuItems))
  }

  // macOS opens the menu of the icon instead of a click of its own; there the menu is the
  // way back to the window.
  if (platform !== 'darwin') tray.on('click', () => { open.run() })
  relabel()

  return {
    tray,
    relabel,
    /** The same entries the floating indicator shows, while any Bot is on the computer. */
    setComputer(next) {
      entries = Array.isArray(next) ? next.filter(entry => entry && typeof entry.label === 'string') : []
      if (!disposed) relabel()
    },
    setCliShim(shim) {
      cliShim = shim
      if (!disposed) relabel()
    },
    setSwarmBadge(alert) {
      swarmAlert = alert && (alert.count || alert.label) ? alert : null
      if (!disposed) relabel()
    },
    /** Take the icon away; the app leaves no dead icon behind. */
    dispose() {
      if (disposed) return
      disposed = true
      try { tray.destroy() } catch (error) { log.warn(`DS Bot: the tray icon did not go away: ${error instanceof Error ? error.message : String(error)}`) }
    },
  }
}
