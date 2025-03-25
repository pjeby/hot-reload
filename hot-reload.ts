import { Plugin, Notice, debounce, Platform, requireApiVersion, App } from "obsidian";
import { around } from "monkey-around"

const watchNeeded = !Platform.isMacOS && !Platform.isWin;

export default class HotReload extends Plugin {

    statCache = new Map();  // path -> Stat
    run = taskQueue()

    reindexPlugins = debounce(() => this.run(() => this.getPluginNames()), 250, true);

    pluginReloaders: Record<string, ()=> unknown> = {}
    pluginNames: Record<string, string> = {}
    enabledPlugins = new Set<string>()
    currentlyLoading = 0

    async onload() {
        await this.getPluginNames();
        this.addCommand({
            id: "scan-for-changes",
            name: "Check plugins for changes and reload them",
            callback: this.reindexPlugins
        })
        this.app.workspace.onLayoutReady(() => {
            this.registerEvent( this.app.vault.on("raw", this.onFileChange));
            this.watch(this.app.plugins.getPluginFolder());
        });
    }

    async watch(path: string) {
        if (this.app.vault.adapter.watchers?.hasOwnProperty(path)) return;
        if ((await this.app.vault.adapter.stat(path))?.type !== "folder") return;
        if (watchNeeded || this.isSymlink(path)) this.app.vault.adapter.startWatchPath(path, false);
    }

    isSymlink = (() => {
        try {
            const {lstatSync} = require('fs');
            return (path: string) => {
                const realPath = [this.app.vault.adapter.basePath, path].join("/");
                const lstat = lstatSync(realPath, {throwIfNoEntry: false});
                return lstat && lstat.isSymbolicLink();
            }
        } catch (e) {
            return () => true;
        }
    })();

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
        this.checkVersion(plugin);
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

        await plugins.disablePlugin(plugin);
        console.debug("disabled", plugin);

        // Ensure sourcemaps are loaded (Obsidian 0.14+)
        const oldDebug = localStorage.getItem("debug-plugin");
        localStorage.setItem("debug-plugin", "1");
        const uninstall = preventSourcemapStripping(this.app, plugin)
        try {
            await plugins.enablePlugin(plugin);
        } finally {
            // Restore previous setting
            if (oldDebug === null) localStorage.removeItem("debug-plugin"); else localStorage.setItem("debug-plugin", oldDebug);
            uninstall?.()
        }
        console.debug("enabled", plugin);
        new Notice(`Plugin "${plugin}" has been reloaded`);
    }
}

function preventSourcemapStripping(app: App, pluginName: string) {
    if (requireApiVersion("1.6")) return(around(app.vault.adapter, {
        read(old) {
            return function (path: string) {
                const res = old.apply(this, arguments as any)
                if (!path.endsWith(`/${pluginName}/main.js`)) return res
                return res.then(txt => txt+'\n/* nosourcemap */')
            }
        },
    }))
}

function taskQueue() {
    let last: Promise<any> = Promise.resolve();
    return <T>(action?: () => T|PromiseLike<T>): Promise<T> => {
        return !action ? last : last = new Promise<T>(
            (res, rej) => last.finally(
                () => { try { res(action()); } catch(e) { rej(e); } }
            )
        )
    }
}

declare module "obsidian" {
    interface Vault {
        exists(path: string): Promise<boolean>
        on(type: "raw", handler: (filename: string) => void): EventRef
    }
    interface DataAdapter {
        basePath: string
        watchers: Record<string, unknown>
        startWatchPath(path: string, flag: boolean): void
    }
    interface App {
        plugins: {
            manifests: Record<string, PluginManifest>
            getPluginFolder(): string
            enablePlugin(plugin: string): Promise<void>
            disablePlugin(plugin: string): Promise<void>
            enabledPlugins: Set<string>
        }
    }
}
