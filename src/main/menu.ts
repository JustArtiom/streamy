import { app, Menu, type MenuItemConstructorOptions } from "electron";

export interface AppActions {
  openSettings: () => void;
  /** Asks for a .torrent file and opens it. */
  openTorrentFile: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
}

/**
 * The app menu. On macOS it's the menu bar at the top of the screen, and it's
 * also what makes ⌘C / ⌘V / ⌘Q work. On Windows/Linux it isn't shown (there's
 * no native title bar); see shortcuts.ts for their keyboard shortcuts.
 */
export function setAppMenu(actions: AppActions): void {
  const isMac = process.platform === "darwin";
  const settings: MenuItemConstructorOptions = {
    label: isMac ? "Settings…" : "Settings",
    accelerator: "CmdOrCtrl+,",
    click: actions.openSettings,
  };
  const openTorrentFile: MenuItemConstructorOptions = {
    label: "Open Torrent File…",
    accelerator: "CmdOrCtrl+O",
    click: actions.openTorrentFile,
  };
  const devTools: MenuItemConstructorOptions[] = app.isPackaged
    ? []
    : [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
      ];

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.getName(),
            submenu: [
              { role: "about" },
              { type: "separator" },
              settings,
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          } satisfies MenuItemConstructorOptions,
          {
            label: "File",
            submenu: [
              openTorrentFile,
              { type: "separator" },
              { role: "close" },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : [
          {
            label: "File",
            submenu: [
              openTorrentFile,
              settings,
              { type: "separator" },
              { role: "quit" },
            ],
          } satisfies MenuItemConstructorOptions,
        ]),
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        ...devTools,
        // Zoom = the "Interface size" setting, so both stay in sync.
        {
          label: "Actual Size",
          accelerator: "CmdOrCtrl+0",
          click: actions.resetZoom,
        },
        {
          label: "Zoom In",
          accelerator: "CmdOrCtrl+Plus",
          click: actions.zoomIn,
        },
        // ⌘= (no Shift) zooms in too, like in browsers.
        {
          label: "Zoom In",
          accelerator: "CmdOrCtrl+=",
          click: actions.zoomIn,
          visible: false,
          acceleratorWorksWhenHidden: true,
        },
        {
          label: "Zoom Out",
          accelerator: "CmdOrCtrl+-",
          click: actions.zoomOut,
        },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
