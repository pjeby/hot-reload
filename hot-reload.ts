import type {
    DataAdapter,
    PluginSettingTab,
    Stat
} from 'obsidian';

import { around } from 'monkey-around';
import {
    App,
    Component,
    debounce,
    FileSystemAdapter,
    Notice,
    Platform,
    Plugin,
    requireApiVersion
} from 'obsidian';

const watchNeeded = !Platform.isMobile && !Platform.isMacOS && !Platform.isWin;

/**
 * Reload the settings tab (and scroll position) of a setting tab
 */
class SettingReloader extends Component {
    private app: App;

    private lastTab: string | undefined = undefined;
    private left = 0;
    private top = 0;

    public constructor(public plugin: Plugin) {
        super();
        this.app = this.plugin.app;
    }

    public override onload(): void {
        const self = this;
        this.plugin.addChild(this); // Ensure we unload when hot-reload does
        this.register(around(Plugin.prototype, {
            addSettingTab(next) {
                return function addSettingTabPatched(this: Plugin, tab: PluginSettingTab): void {
                    next.call(this, tab);
                    if (!(self.lastTab && this.manifest.id === self.lastTab)) {
                        return;
                    }
                    const { lastTab, left, top } = self;
                    // Only try this once per plugin id per disable
                    self.lastTab = undefined;
                    setTimeout(() => {
                        if (
                            self.lastTab // Another state was saved
                            || !this.app.setting.containerEl.isShown() // Settings not open
                            || this.app.setting.activeTab // Not on the previously-closed tab
                        ) {
                            return;
                        }
                        this.app.setting.openTabById(lastTab);
                        tab.containerEl.scrollTo({ left, top });
                    }, 100);
                };
            }
        }));
    }

    /**
     * Is the plugin's setting tab active and on-screen?  If so, save its scroll
     * position and set it up to refresh after load.
     */
    public onPluginDisable(pluginID: string): void {
        if (!(this.app.setting.activeTab?.id === pluginID && this.app.setting.containerEl.isShown())) {
            return;
        }

        const { scrollLeft: left, scrollTop: top } = this.app.setting.activeTab.containerEl;
        this.lastTab = pluginID;
        this.left = left;
        this.top = top;
        // Set up the hook to detect the setting tab registration (if not already set up)
        this.load();
    }
}

function taskQueue(): (action?: () => Promise<void> | void) => Promise<void> {
    let last: Promise<void> = Promise.resolve();
    return (action?: () => Promise<void> | void): Promise<void> => {
        if (action) {
            last = new Promise<void>((res, rej) => {
                last.catch(console.error).finally(() => {
                    try {
                        res(action());
                    } catch (e) {
                        rej(e as Error);
                    }
                });
            });
        }

        return last;
    };
}

export default class HotReload extends Plugin {
    private asyncRun: (action: () => Promise<void> | void) => Promise<void> = taskQueue();
    private enabledPlugins = new Set<string>();
    private pluginNames: Record<string, string> = {};
    private pluginReloaders: Record<string, () => void> = {};

    private reindexPlugins = debounce(
        () => {
            this.run(() => this.getPluginNames());
        },
        250,
        true
    );

    private settingReloader = new SettingReloader(this);
    private statCache = new Map<string, Stat>(); // Path -> Stat

    public override onload(): void {
        this.app.workspace.onLayoutReady(async () => {
            await this.getPluginNames();
            this.addCommand({
                callback: this.reindexPlugins,
                id: 'scan-for-changes',
                name: 'Check plugins for changes and reload them'
            });
            this.registerEvent(this.app.vault.on('raw', (filename) => {
                this.onFileChange(filename).catch(console.error);
            }));
            await this.watch(this.app.plugins.getPluginFolder());
        });
    }

    private async checkVersion(plugin: string): Promise<void> {
        const { dir } = this.app.plugins.manifests[plugin] ?? {};
        if (!dir) {
            // Deleted plugin, stop watching
            delete this.pluginNames[plugin];
            return;
        }

        for (const file of ['main.js', 'styles.css']) {
            const path = `${dir}/${file}`;
            const stat = await this.app.vault.adapter.stat(path);
            if (stat) {
                if (this.statCache.has(path) && stat.mtime !== this.statCache.get(path)?.mtime) {
                    this.requestReload(plugin);
                }
                this.statCache.set(path, stat);
            }
        }
    }

    private async checkVersions(): Promise<void> {
        await Promise.all(Object.values(this.pluginNames).map(this.checkVersion.bind(this)));
    }

    private async getPluginNames(): Promise<void> {
        const enabled = new Set<string>();
        const plugins: Record<string, string> = {};
        for (const { dir, id } of Object.values(this.app.plugins.manifests)) {
            if (!dir) {
                continue;
            }

            await this.watch(dir);
            const pluginName = dir.split('/').pop() ?? '';
            plugins[pluginName] = id;
            if (
                await this.app.vault.exists(`${dir}/.git`)
                || await this.app.vault.exists(`${dir}/.hotreload`)
            ) {
                enabled.add(id);
            }
        }
        this.pluginNames = plugins;
        this.enabledPlugins = enabled;
        await this.checkVersions();
    }

    private isSymlink(path: string): boolean {
        if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
            return false;
        }

        try {
            const realPath = [this.app.vault.adapter.basePath, path].join('/');
            const lstat = this.app.vault.adapter.fs.lstatSync(realPath, { throwIfNoEntry: false });
            return !!lstat?.isSymbolicLink();
        } catch {
            return true;
        }
    }

    private async onFileChange(filename: string): Promise<void> {
        if (!filename.startsWith(`${this.app.plugins.getPluginFolder()}/`)) {
            return;
        }
        const path = filename.split('/');
        const base = path.pop();
        const dir = path.pop();
        if (path.length === 1 && dir === 'plugins') {
            await this.watch(filename);
            return;
        }
        if (path.length !== 2) {
            return;
        }
        const plugin = dir && this.pluginNames[dir];
        if (base === 'manifest.json' || base === '.hotreload' || base === '.git' || !plugin) {
            this.reindexPlugins();
            return;
        }
        if (base !== 'main.js' && base !== 'styles.css') {
            return;
        }
        await this.checkVersion(plugin);
    }

    private async reload(plugin: string): Promise<void> {
        const plugins = this.app.plugins;

        // Don't reload disabled plugins
        if (!plugins.enabledPlugins.has(plugin)) {
            return;
        }

        this.settingReloader.onPluginDisable(plugin);

        await plugins.disablePlugin(plugin);
        console.debug('disabled', plugin);

        // Ensure sourcemaps are loaded (Obsidian 0.14+)
        const oldDebug = localStorage.getItem('debug-plugin');
        localStorage.setItem('debug-plugin', '1');
        const uninstall = preventSourcemapStripping(this.app, plugin);
        try {
            await plugins.enablePlugin(plugin);
        } finally {
            // Restore previous setting
            if (oldDebug === null) {
                localStorage.removeItem('debug-plugin');
            } else {
                localStorage.setItem('debug-plugin', oldDebug);
            }
            uninstall();
        }
        console.debug('enabled', plugin);
        new Notice(`Plugin "${plugin}" has been reloaded`);
    }

    private requestReload(plugin: string): void {
        if (!this.enabledPlugins.has(plugin)) {
            return;
        }

        const reloader = this.pluginReloaders[plugin] ?? (
            this.pluginReloaders[plugin] = debounce(
                () => {
                    this.run(() => this.reload(plugin));
                },
                750,
                true
            )
        );
        reloader();
    }

    private run(action: () => Promise<void> | void): void {
        this.asyncRun(action).catch(console.error);
    }

    private async watch(path: string): Promise<void> {
        if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
            return;
        }

        if (Object.hasOwn(this.app.vault.adapter.watchers, path)) {
            return;
        }
        if ((await this.app.vault.adapter.stat(path))?.type !== 'folder') {
            return;
        }
        if (watchNeeded || this.isSymlink(path)) {
            this.app.vault.adapter.startWatchPath(path);
        }
    }
}

function preventSourcemapStripping(app: App, pluginName: string): () => void {
    if (!requireApiVersion('1.6')) {
        return () => {
            // No-op
        };
    }
    return around(app.vault.adapter, {
        read(old) {
            return async function readPatched(this: DataAdapter, normalizedPath: string) {
                const txt = await old.call(this, normalizedPath);
                if (!normalizedPath.endsWith(`/${pluginName}/main.js`)) {
                    return txt;
                }
                return `${txt}\n/* nosourcemap */`;
            };
        }
    });
}

declare module 'obsidian' {
    interface App {
        plugins: {
            disablePlugin(plugin: string): Promise<void>;
            enabledPlugins: Set<string>;
            enablePlugin(plugin: string): Promise<void>;
            getPluginFolder(): string;
            manifests: Record<string, PluginManifest>;
            plugins: Record<string, Plugin>;
        };
        setting: {
            activeTab: { id: string } & SettingTab | null;
            containerEl: HTMLElement;
            openTabById(id: string): null | SettingTab;
        };
    }
    interface DataAdapter {
        basePath: string;
    }
    interface FileSystemAdapter extends DataAdapter {
        fs: typeof import('node:fs');
        startWatchPath(path: string): void;
        watchers: Record<string, unknown>;
    }
    interface Vault {
        exists(path: string): Promise<boolean>;
        on(type: 'raw', handler: (filename: string) => void): EventRef;
    }
}
