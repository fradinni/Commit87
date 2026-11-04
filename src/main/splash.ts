import { BrowserWindow } from 'electron'

/**
 * A tiny, dependency-free window shown as soon as Electron is ready. It fills
 * the gap between the AppImage/Electron start-up and the first paint of the
 * React renderer, which is where a cold start feels the slowest.
 */
export function createSplashWindow(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 380,
    height: 248,
    center: true,
    frame: false,
    resizable: false,
    movable: false,
    show: false,
    skipTaskbar: true,
    backgroundColor: '#0b1015',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: false,
      spellcheck: false
    }
  })

  splash.setMenuBarVisibility(false)
  splash.once('ready-to-show', () => {
    if (!splash.isDestroyed()) splash.show()
  })
  void splash.loadURL(`data:text/html;base64,${Buffer.from(SPLASH_HTML).toString('base64')}`)
  return splash
}

const SPLASH_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      * { box-sizing: border-box; }
      html, body {
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: #0b1015;
        color: #e6edf3;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif;
      }
      body {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 13px;
        background: radial-gradient(circle at 50% 18%, #12251f 0%, #0b1015 62%);
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 21px;
        font-weight: 650;
        letter-spacing: -0.02em;
      }
      .tagline {
        color: #7f8f9e;
        font-size: 11px;
        letter-spacing: 0.01em;
      }
      .bar {
        width: 168px;
        height: 3px;
        margin-top: 8px;
        border-radius: 99px;
        background: #1b2a36;
        overflow: hidden;
      }
      .bar span {
        display: block;
        width: 42%;
        height: 100%;
        border-radius: 99px;
        background: #3ddc97;
        animation: slide 1.05s ease-in-out infinite;
      }
      @keyframes slide {
        0% { transform: translateX(-110%); }
        100% { transform: translateX(340%); }
      }
    </style>
  </head>
  <body>
    <div class="brand">
      <svg width="34" height="34" viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <rect width="32" height="32" rx="8" fill="#0f2b22" />
        <path d="M10 8v9.2a4 4 0 0 0 4 4h8" stroke="#3ddc97" stroke-width="2.4" stroke-linecap="round" />
        <path d="M10 17.5v6" stroke="#5ba8ff" stroke-width="2.4" stroke-linecap="round" />
        <circle cx="10" cy="7.5" r="2.4" fill="#3ddc97" />
        <circle cx="10" cy="25" r="2.4" fill="#5ba8ff" />
        <circle cx="22.5" cy="21.2" r="2.4" fill="#c792ea" />
        <path d="M22.5 21.2v-5" stroke="#c792ea" stroke-width="2" stroke-linecap="round" />
        <circle cx="22.5" cy="13.5" r="2.2" fill="#c792ea" />
      </svg>
      <span>GitGrove</span>
    </div>
    <div class="tagline">Opening repositories…</div>
    <div class="bar"><span></span></div>
  </body>
</html>`
