import { Menu, Tray, nativeImage } from 'electron'
import { resourcePath } from './resources'

export interface TrayActions {
  openMain: () => void
  toggleSession: () => void
  toggleOverlay: () => void
  openSettings: () => void
  quit: () => void
  isLive: () => boolean
  isOverlayVisible: () => boolean
}

/** Bluely always shows a tray icon while it runs. */
export class AppTray {
  private tray: Tray

  constructor(private readonly actions: TrayActions) {
    const icon = nativeImage.createFromPath(
      resourcePath(process.platform === 'win32' ? 'tray.ico' : 'tray.png'),
    )
    this.tray = new Tray(icon)
    this.tray.setToolTip('Bluely')
    this.tray.on('click', () => actions.openMain())
    this.refresh()
  }

  refresh(): void {
    const live = this.actions.isLive()
    this.tray.setToolTip(live ? 'Bluely: listening' : 'Bluely')
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Bluely', click: () => this.actions.openMain() },
        {
          label: live ? 'Stop session' : 'Start Bluely',
          click: () => this.actions.toggleSession(),
        },
        {
          label: this.actions.isOverlayVisible() ? 'Hide overlay' : 'Show overlay',
          click: () => this.actions.toggleOverlay(),
        },
        { type: 'separator' },
        { label: 'Settings', click: () => this.actions.openSettings() },
        { type: 'separator' },
        { label: 'Quit Bluely', click: () => this.actions.quit() },
      ]),
    )
  }

  destroy(): void {
    this.tray.destroy()
  }
}
