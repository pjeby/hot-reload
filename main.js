const {Plugin, Notice} = require("obsidian");

const watchNeeded = window.process.platform !== "darwin" && window.process.platform !== "win32";

module.exports = class HotReload extends Plugin {

    async onload() {
        this.pluginReloaders = {};
        this.inProgress = null;
        await this.getPluginNames();
        this.reindexPlugins = this.debouncedMethod(500, this.getPluginNames);
        this.registerEvent( this.app.vault.on("raw", this.onFileChange.bind(this)) );
    }

    watch(path) {
        if (watchNeeded) this.app.vault.adapter.startWatchPath(path, false);
    }

    async getPluginNames() {
        await this.app.plugins.loadManifests();
        const plugins = {}, enabled = new Set();
        for (const {id, dir} of Object.values(app.plugins.manifests)) {
            plugins[dir.split("/").pop()] = id;
            if (
                await this.app.vault.exists(dir+"/.git") ||
                await this.app.vault.exists(dir+"/.hotreload")
            ) {
                enabled.add(id);
                this.watch(dir);
            }
        }
        this.pluginNames = plugins;
        this.enabledPlugins = enabled;
    }

    onFileChange(filename) {
        if (!filename.startsWith(".obsidian/plugins/")) return;
        const path = filename.split("/");
        const base = path.pop(), dir = path.pop();
        if (path.length != 2) return;
        const plugin = dir && this.pluginNames[dir];
        if (base === "manifest.json" || base === ".hotreload" || base === ".git" || !plugin) return this.reindexPlugins();
        if (base !== "main.js" && base !== "styles.css") return;
        if (!this.enabledPlugins.has(plugin)) return;
        const reloader = this.pluginReloaders[plugin] || (
            this.pluginReloaders[plugin] = this.debouncedMethod(750, this.requestReload, plugin)
        );
        reloader();
    }

    requestReload(plugin) {
        const next = this.inProgress = this.reload(plugin, this.inProgress);
        next.finally(() => {if (this.inProgress === next) this.inProgress = null;})
    }

    async reload(plugin, previous) {
        const plugins = this.app.plugins;
        try {
            // Wait for any other queued/in-progress reloads to finish
            await previous;
            await plugins.disablePlugin(plugin);
            console.debug("disabled", plugin);
            await plugins.enablePlugin(plugin);
            console.debug("enabled", plugin);
            new Notice(`Plugin "${plugin}" has been reloaded`);
        } catch(e) {}
    }

    debouncedMethod(ms, func, ...args) {
        var timeout;
        return () => {
            if (timeout) clearTimeout(timeout);
            timeout = setTimeout( () => { timeout = null; func.apply(this, args); }, ms);
        }
    }
}