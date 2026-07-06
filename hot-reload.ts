import { Plugin, Notice, debounce, Platform, requireApiVersion, App, Component, FileSystemAdapter } from "obsidian";
import * as o from "obsidian"
import { around } from "monkey-around"

const watchNeeded = !Platform.isMacOS && !Platform.isWin;

export default class HotReload extends Plugin {

    statCache = new Map<string, o.Stat>();  // path -> Stat
    run = taskQueue()

    reindexPlugins: () => void = debounce((): void => void this.run(() => this.getPluginNames()), 250, true);

    pluginReloaders: Record<string, ()=> unknown> = {}
    pluginNames: Record<string, string> = {}
    enabledPlugins = new Set<string>()
    currentlyLoading = 0

    settingReloader = new SettingReloader(this)

    onload() {
        this.app.workspace.onLayoutReady(async () => {
            await this.getPluginNames();
            this.addCommand({
                id: "scan-for-changes",
                name: "Check plugins for changes and reload them",
                callback: this.reindexPlugins
            })
            this.registerEvent( this.app.vault.on("raw", this.onFileChange));
            this.watch(this.app.plugins.getPluginFolder());
        });
    }

    watch(path: string) {
        const {adapter} = this.app.vault;
        if (!(adapter instanceof FileSystemAdapter) || hasOwnProperty(adapter.watchers, path)) return;
        void (async () => {
            if ((await adapter.stat(path))?.type !== "folder") return;
            if (watchNeeded || this.isSymlink(adapter, path)) adapter.startWatchPath(path);
        })()
    }

    isSymlink = (adapter: FileSystemAdapter, path: string) => {
        const realPath = [adapter.basePath, path].join("/");
        const lstat = adapter.fs.lstatSync(realPath, {throwIfNoEntry: false});
        return lstat && lstat.isSymbolicLink();
    }

    checkVersions() {
        return Promise.all(Object.values(this.pluginNames).map(this.checkVersion))
    }

    checkVersion = async (plugin: string) => {
        const {dir} = (this.app.plugins.manifests[plugin] || {})
        if (dir) for (const file of ["main.js", "styles.css"]) {
            const path = `${dir}/${file}`;
            const stat = await this.app.vault.adapter.stat(path);
            if (stat) {
                if (this.statCache.has(path) && stat.mtime !== this.statCache.get(path).mtime) {
                    this.requestReload(plugin);
                }
                this.statCache.set(path, stat);
            }
        } else {
            // Deleted plugin, stop watching
            delete this.pluginNames[plugin]
        }
    }

    async getPluginNames() {
        const plugins: Record<string, string> = {}, enabled = new Set<string>();
        for (const {id, dir} of Object.values(this.app.plugins.manifests)) {
            this.watch(dir);
            plugins[dir.split("/").pop()] = id;
            if (
                await this.app.vault.exists(dir+"/.git") ||
                await this.app.vault.exists(dir+"/.hotreload")
            ) enabled.add(id);
        }
        this.pluginNames = plugins;
        this.enabledPlugins = enabled;
        await this.checkVersions()
    }

    onFileChange = (filename: string) => {
        if (!filename.startsWith(this.app.plugins.getPluginFolder()+"/")) return;
        const path = filename.split("/");
        const base = path.pop(), dir = path.pop();
        if (path.length === 1 && dir === "plugins") return this.watch(filename);
        if (path.length != 2) return;
        const plugin = dir && this.pluginNames[dir];
        if (base === "manifest.json" || base === ".hotreload" || base === ".git" || !plugin) return this.reindexPlugins();
        if (base !== "main.js" && base !== "styles.css") return;
        void this.checkVersion(plugin);
    }

    requestReload(plugin: string) {
        if (!this.enabledPlugins.has(plugin)) return;
        const reloader = this.pluginReloaders[plugin] || (
            this.pluginReloaders[plugin] = debounce(() => this.run(() => this.reload(plugin).catch(console.error)), 750, true)
        );
        reloader();
    }

    async reload(plugin: string) {
        const plugins = this.app.plugins;

        // Don't reload disabled plugins
        if (!plugins.enabledPlugins.has(plugin)) return;

        this.settingReloader.onPluginDisable(plugin);

        await plugins.disablePlugin(plugin);
        console.debug("disabled", plugin);

        // Ensure sourcemaps are loaded (Obsidian 0.14+)
        const oldDebug = store.getItem("debug-plugin");
        store.setItem("debug-plugin", "1");
        const uninstall = preventSourcemapStripping(this.app, plugin)
        try {
            await plugins.enablePlugin(plugin);
        } finally {
            // Restore previous setting
            if (oldDebug === null) store.removeItem("debug-plugin"); else store.setItem("debug-plugin", oldDebug);
            uninstall?.()
        }
        console.debug("enabled", plugin);
        new Notice(`Plugin "${plugin}" has been reloaded`);
    }
}

function preventSourcemapStripping(app: App, pluginName: string) {
    if (requireApiVersion("1.6")) return(around(app.vault.adapter, {
        read(old) {
            return function (path: string, ...args: unknown[]) {
                const res = old.call(this, path, ...args)
                if (!path.endsWith(`/${pluginName}/main.js`)) return res
                return res.then(txt => txt+'\n/* nosourcemap */')
            }
        },
    }))
}

function taskQueue() {
    let last: Promise<unknown> = Promise.resolve();
    return <T>(action?: () => T|PromiseLike<T>): Promise<T> => {
        return !action ? last as Promise<T>: last = new Promise<T>(
            (res, rej) => void last.finally(
                () => { try { res(action()); } catch(e) { let _e: Error = e; rej(_e); } }
            )
        )
    }
}

/**
 * Reload the settings tab (and scroll position) of a setting tab
 */
class SettingReloader extends Component {
    constructor(public plugin: Plugin) { super(); }

    app = this.plugin.app
    left = 0
    top = 0
    lastTab: string = undefined

    /**
     * Is the plugin's setting tab active and on-screen?  If so, save its scroll
     * position and set it up to refresh after load.
     */
    onPluginDisable(pluginID: string) {
        if (this.app.setting.activeTab?.id === pluginID && this.app.setting.containerEl.isShown()) {
            const {scrollTop: top, scrollLeft: left} = this.app.setting.activeTab.containerEl;
            this.lastTab = pluginID;
            this.left = left;
            this.top = top;
            // set up the hook to detect the setting tab registration (if not already set up)
            this.load();
        }
    }

    onload() {
        const self = (() => this)(); // eslint yak-shaving
        this.plugin.addChild(this) // ensure we unload when hot-reload does
        this.register(around(Plugin.prototype, {
            addSettingTab(next) {
                return function(this: Plugin, tab, ...args: unknown[]) {
                    next.call(this, tab, ...args);
                    if (self.lastTab && this.manifest.id === self.lastTab) {
                        const {lastTab, left, top} = self;
                        // only try this once per plugin id per disable
                        self.lastTab = undefined;
                        void activeWindow.sleep(100).then(() => {
                            if (
                                self.lastTab ||  // another state was saved
                                !this.app.setting.containerEl.isShown() ||  // settings not open
                                this.app.setting.activeTab  // not on the previously-closed tab
                            ) return;
                            this.app.setting.openTabById(lastTab);
                            tab.containerEl.scrollTo({left, top});
                        })
                    }
                }
            }
        }));
    }
}

function hasOwnProperty(ob: object, prop: string) {
    return !!ob && Object.prototype.hasOwnProperty.call(ob, prop)
}

const store = window["localStorage"]

declare module "obsidian" {
    interface Vault {
        exists(path: string): Promise<boolean>
        on(type: "raw", handler: (filename: string) => void): EventRef
    }
    interface FileSystemAdapter {
        fs: { lstatSync(path: string, options: {throwIfNoEntry: boolean}): { isSymbolicLink(): boolean }}
        basePath: string
        watchers: Record<string, unknown>
        startWatchPath(path: string): void
    }
    interface App {
        plugins: {
            manifests: Record<string, PluginManifest>
            getPluginFolder(): string
            enablePlugin(plugin: string): Promise<void>
            disablePlugin(plugin: string): Promise<void>
            enabledPlugins: Set<string>
            plugins: Record<string, Plugin>
        }
        setting: {
            activeTab: o.SettingTab & { id: string } | null
            containerEl: HTMLElement
            openTabById(id: string): o.SettingTab | null
        }
    }
}
