import path from 'path';
import http from 'http';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

import { app, BrowserWindow, dialog, Menu, net, protocol, shell } from 'electron';
import { spawn, execFile } from 'child_process';
import { updateElectronApp, UpdateSourceType } from 'update-electron-app';

import { isDirty, registerDatabaseIpc } from './electron/ipc.js';
import { appearance, loadAppearance } from './electron/appearance-store.js';
import { startLinuxAutoUpdate } from './electron/linux-updater.js';
import { describeError, installProcessHandlers, log, logPath } from './electron/log.js';
import { updateFeed } from './shared/update-feed.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const require = createRequire(import.meta.url);

// The Windows installer and updater run the app with --squirrel-install,
// -updated, -uninstall or -obsolete. This creates or removes the Start Menu and
// desktop shortcuts and quits, so nothing else may start on those runs.
const handledSquirrelEvent = process.platform === 'win32' && require('electron-squirrel-startup');

// productName (DBison) names the app, but the data folder keeps the name it has
// always had: on Linux ~/.config/DBison would be a new, empty folder beside the
// ~/.config/dbison that holds every saved connection.
// An explicit --user-data-dir (a second profile, a test run) wins.
if (!app.commandLine.hasSwitch('user-data-dir')) {
    app.setPath('userData', path.join(app.getPath('appData'), 'dbison'));
}

// Squirrel's shortcuts carry this id; the running app has to match it for
// taskbar pins and notifications to group with the shortcut.
if (process.platform === 'win32') app.setAppUserModelId('com.squirrel.dbison.dbison');

// One app per profile: a second launch focuses the window already open rather
// than starting another copy over the same stores. The lock is keyed on the
// userData path, so it is taken once that is settled.
const isPrimaryInstance = handledSquirrelEvent || app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();

app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
});

// Packaged builds load the renderer from the app's own app://dbison protocol,
// read straight out of the asar (see `serveRenderer`). Nothing listens on a
// port, so no other local process can answer in the app's place and inherit
// its preload bridge. From source the Nuxt dev server provides hot reload.
const APP_SCHEME = 'app';
const APP_HOST = 'dbison';
const DEV_HOST = '127.0.0.1';
const DEV_PORT = Number(process.env.NUXT_PORT ?? 3000);
const APP_URL = app.isPackaged ? `${APP_SCHEME}://${APP_HOST}` : `http://${DEV_HOST}:${DEV_PORT}`;

// The `nuxt generate` output, packaged inside the asar.
const RENDERER_ROOT = path.join(__dirname, '.output', 'public');

// Before `ready`. A standard, secure scheme gets an origin of its own, with
// localStorage, module scripts, workers and fetch, as https would.
protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
]);

// The same markup Nuxt shows while its bundle boots (`spaLoadingTemplate`),
// loaded straight off disk so the window has something to show during the much
// longer wait before the server answers at all.
const SPLASH_FILE = path.join(__dirname, 'shared', 'splash.html');

let nuxtProcess;
let connectionManager;

// Whatever nothing else catches goes to the log file rather than to a
// dialog that quits the app; see electron/log.js.
installProcessHandlers();

// Starts the Nuxt dev server when running from source; it listens on APP_URL.
function startDevServer() {
    const nuxtBin = path.join(__dirname, 'node_modules', 'nuxt', 'bin', 'nuxt.mjs');

    return spawn(process.execPath, [nuxtBin, 'dev', '--host', DEV_HOST, '--port', String(DEV_PORT)], {
        cwd: __dirname,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: 'inherit',
    });
}

// Answers app://dbison/… from the generated renderer. A path without an
// extension is a route of the SPA and gets its shell; one that would resolve
// outside the renderer folder is refused.
function serveRenderer() {
    protocol.handle(APP_SCHEME, async (request) => {
        const url = new URL(request.url);
        if (url.host !== APP_HOST) return new Response(null, { status: 404 });

        let file;
        try {
            file = path.join(RENDERER_ROOT, decodeURIComponent(url.pathname));
        } catch {
            return new Response(null, { status: 400 });
        }
        if (file !== RENDERER_ROOT && !file.startsWith(RENDERER_ROOT + path.sep)) {
            return new Response(null, { status: 403 });
        }

        const target = path.extname(file) ? file : path.join(RENDERER_ROOT, 'index.html');
        try {
            return await net.fetch(pathToFileURL(target).toString());
        } catch {
            return new Response(null, { status: 404 });
        }
    });
}

// Polls until the server accepts a request, so we never loadURL into a
// connection-refused. The dev server needs a while on a cold .nuxt build.
function waitForServer(timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;

    return new Promise((resolve, reject) => {
        const attempt = () => {
            const req = http.get(APP_URL, (res) => {
                res.resume();
                resolve();
            });

            req.on('error', () => {
                if (Date.now() > deadline) {
                    reject(new Error(`Nuxt did not start on ${APP_URL} within ${timeoutMs}ms`));
                    return;
                }
                setTimeout(attempt, 300);
            });
        };

        attempt();
    });
}

// Electron installs a default File/Edit/View/Window/Help menu when the app sets
// none, which sat directly above the app's own menu bar: two menu bars, one of
// them not ours. AppMenuBar is the menu, so the native one goes.
Menu.setApplicationMenu(null);

// Removing the menu also removes the accelerators its roles carried. Chromium
// still handles cut/copy/paste and undo in fields itself, but reload and
// devtools came only from the menu, so they are bound back here for
// development. Packaged builds get neither.
function bindDeveloperKeys(webContents) {
    if (app.isPackaged) {
        return;
    }

    webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') {
            return;
        }

        const key = input.key.toLowerCase();

        if (key === 'f12' || (input.control && input.shift && key === 'i')) {
            webContents.toggleDevTools();
            event.preventDefault();
        } else if (input.control && key === 'r') {
            webContents.reloadIgnoringCache();
            event.preventDefault();
        }
    });
}

// The app's own menu bar is the title bar. The native one is hidden on every
// platform and only the window controls are kept: on Windows and Linux Chromium
// paints minimise/maximise/close over the top-right corner of the page (the
// Window Controls Overlay), on macOS the traffic lights stay in the top-left.
// Either way the renderer learns where they are through the
// `env(titlebar-area-*)` CSS variables, which `.app-titlebar` in main.css uses
// to keep the logo and menus clear of them. The overlay's colours follow the
// theme: `useAppTheme` pushes the surface and text tokens over IPC and
// `electron/ipc.js` applies them with `setTitleBarOverlay`.
export const TITLE_BAR_HEIGHT = 40;

// The palette the last session left behind (`electron/appearance-store.js`),
// so the very first frame is already in the right theme; the renderer corrects
// it over IPC anyway once it has restored the persisted choice.
export function titleBarOptions() {
    const { color, symbolColor } = appearance();

    return {
        titleBarStyle: 'hidden',
        titleBarOverlay: { color, symbolColor, height: TITLE_BAR_HEIGHT },
        // Centres the 12px traffic lights in the bar on macOS.
        trafficLightPosition: { x: 12, y: (TITLE_BAR_HEIGHT - 12) / 2 },
    };
}

// Rewrites the line under the load screen's progress bar. The splash is a
// plain document with no preload of its own, so this talks to it the only way
// it can. Silent on failure: by the time it lands the window may have moved on
// to the app, which is not a problem worth a log line.
function splashStatus(webContents, message) {
    webContents
        .executeJavaScript(
            `document.querySelector('[data-splash-status]')?.replaceChildren(${JSON.stringify(message)})`,
        )
        .catch(() => {});
}

async function createWindow() {
    const mainWindow = new BrowserWindow({
        width: 1000, // window's initial width

        height: 600, // window's initial height

        // Chromium paints this before any document has loaded. Without it the
        // frame that precedes the load screen is white, which on a dark theme
        // is the brightest thing the app ever shows.
        backgroundColor: appearance().background,

        // Windows and macOS take the icon from the exe and the app bundle; a
        // Linux window has to be handed one.
        ...(process.platform === 'linux' ? { icon: path.join(__dirname, 'assets', 'icon.png') } : {}),

        ...titleBarOptions(),

        webPreferences: {
            // The renderer reaches databases only through this bridge; drivers
            // and credentials stay in the main process.
            preload: path.join(__dirname, 'electron', 'preload.cjs'),

            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
        },
    });

    bindDeveloperKeys(mainWindow.webContents);

    // The renderer is the app and nothing else: a link in a result cell or
    // a dragged file must not navigate the window away, and nothing here
    // opens a second window. An http(s) link is handed to the browser, a
    // mailto: link (the author's address in About) to the mail app, and a
    // bitcoin: payment link (Help ▸ Support DBison) to the user's wallet app.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^(https?:\/\/|mailto:|bitcoin:)/i.test(url)) shell.openExternal(url).catch(() => {});
        return { action: 'deny' };
    });
    // Only the app's own pages, not file:// either: a dropped .html file would
    // otherwise open with the preload bridge attached.
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (url === APP_URL || url.startsWith(`${APP_URL}/`)) return;
        event.preventDefault();
    });

    // The renderer reports whether it holds unsaved work (a dirty script, a
    // grid with staged edits, an open transaction); closing on it asks first.
    // Asked here because once the close has begun the page cannot show a
    // dialog of its own.
    mainWindow.on('close', (event) => {
        if (!isDirty(mainWindow.webContents)) return;

        const choice = dialog.showMessageBoxSync(mainWindow, {
            type: 'warning',
            buttons: ['Close anyway', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            title: 'Unsaved work',
            message: 'Unsaved changes will be lost.',
            detail: 'A script, staged edits or an open transaction has not been saved. Close the window anyway?',
        });

        if (choice !== 0) event.preventDefault();
    });

    // From source, the dev server first: it is what everything after this waits
    // on, and the load screen is a local file that costs a frame to put up.
    if (!app.isPackaged && !nuxtProcess) {
        nuxtProcess = startDevServer();
        nuxtProcess.on('exit', (code) => {
            if (code !== 0 && code !== null) {
                log('error', `Nuxt process exited with code ${code}`);
            }
        });
    }

    // The same load screen Nuxt keeps showing once the server answers, so the
    // hand-off is a status line changing rather than a second screen.
    // From source only. A packaged build has no server to wait for, and its
    // index.html carries this same markup; the GrantFileProtocolExtraPrivileges
    // fuse also keeps file:// pages from reading inside the asar. A load screen
    // that fails to show is no reason not to open the app.
    if (!app.isPackaged) {
        await mainWindow.loadFile(SPLASH_FILE, { query: { theme: appearance().theme } }).catch((error) => {
            log('warn', `Load screen did not show: ${error.message}`);
        });
        splashStatus(mainWindow.webContents, 'Starting the dev server…');
    }

    try {
        if (!app.isPackaged) await waitForServer();

        splashStatus(mainWindow.webContents, 'Loading the workspace…');

        await mainWindow.loadURL(APP_URL);
    } catch (error) {
        log('error', `Failed to load the app: ${error.message}`, describeError(error));
        const escaped = String(error.message).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
        await mainWindow.loadURL(
            `data:text/html,${encodeURIComponent(`<h1>Failed to start</h1><pre>${escaped}</pre><p>Details are in ${logPath()}</p>`)}`,
        );
    }
}

// Checks the release bucket named in package.json's `updates` field every so
// often, and once an update has downloaded, offers to restart. Packaged builds
// only: from source there is no installed app to replace. Left silent rather
// than fatal when it cannot run, since a failed update check is no reason not
// to open the workspace.
function startAutoUpdate() {
    if (!app.isPackaged) return;

    // Squirrel still holds its lock for a moment after installing, and a check
    // in that window fails; the next start checks instead.
    if (process.argv.includes('--squirrel-firstrun')) {
        log('info', 'Auto-update skipped on the first run after install');
        return;
    }

    let feed = null;
    try {
        feed = updateFeed(require('./package.json'));
    } catch {
        // Treated as unconfigured below.
    }
    if (!feed) {
        log('info', 'Auto-update disabled: package.json has no complete `updates` field');
        return;
    }

    // The library logs as (label, value, ...); each call becomes one line in
    // the app log under the level it chose, so update trouble sits with the rest.
    const line = (args) => `[update] ${args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a))).join(' ')}`;

    const logger = {
        log: (...args) => log('info', line(args)),
        info: (...args) => log('info', line(args)),
        warn: (...args) => log('warn', line(args)),
        error: (...args) => log('error', line(args)),
    };

    // Squirrel covers Windows and macOS; Linux packages go through
    // electron-updater, see electron/linux-updater.js.
    if (process.platform === 'linux') {
        startLinuxAutoUpdate(feed.baseUrl('linux', process.arch), logger).catch((error) => {
            log('warn', `Auto-update could not start: ${error?.message ?? error}`, describeError(error));
        });
        return;
    }

    try {
        updateElectronApp({
            updateSource: { type: UpdateSourceType.StaticStorage, baseUrl: feed.baseUrl(process.platform, process.arch) },
            updateInterval: '1 hour',
            logger,
        });
    } catch (error) {
        log('warn', `Auto-update could not start: ${error?.message ?? error}`, describeError(error));
    }
}

// Creates the window when electron app is ready
app.whenReady().then(async () => {
    if (handledSquirrelEvent || !isPrimaryInstance) return;

    if (app.isPackaged) serveRenderer();

    // Before the first window: it decides the colours that window opens on.
    await loadAppearance();

    log('info', `DBison ${app.getVersion()} starting (${process.platform} ${process.arch}, Electron ${process.versions.electron})`);

    startAutoUpdate();

    connectionManager = await registerDatabaseIpc();

    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

// Terminates the electron app when all windows are closed.
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// Terminates the Nuxt app before closing the electron app.
// Otherwise, Nuxt server would keep running.
app.on('before-quit', () => {
    // Close database sessions first, so pools are not left dangling server-side.
    connectionManager?.shutdown();

    if (!nuxtProcess || nuxtProcess.killed) {
        return;
    }

    if (process.platform === 'win32') {
        // Nuxt spawns child processes of its own; plain kill() orphans them.
        execFile('taskkill', ['/pid', String(nuxtProcess.pid), '/T', '/F']);
    } else {
        nuxtProcess.kill();
    }

    nuxtProcess = undefined;
});
