const {Plugin} = require("obsidian");

module.exports = class HotReload extends Plugin {

    async onload() {
        this.pluginReloaders = {};
        this.lastReload = null;
        await this.getPluginNames();
        this.reindexPlugins = this.debouncedMethod(500, this.getPluginNames);
        this.registerEvent( this.app.vault.on("raw", this.onFileChange.bind(this)) );
    }

    async getPluginNames() {
        await this.app.plugins.loadManifests();
        const plugins = {}, enabled = new Set();
        for (const {id, dir} of Object.values(app.plugins.manifests)) {
            plugins[dir.split("/").pop()] = id;
            if (
                await this.app.vault.exists(dir+"/.git") ||
                await this.app.vault.exists(dir+"/.hotreload")
            ) enabled.add(id);
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
        this.lastReload = this.reload(plugin);
    }

    async reload(plugin) {
        const plugins = this.app.plugins;
        try {
            // Wait for any other queued/in-progress reloads to finish
            if (this.lastReload) await this.lastReload;
            await plugins.disablePlugin(plugin);
            console.debug("disabled", plugin);
            await plugins.enablePlugin(plugin);
            console.debug("enabled", plugin);
        } catch(e) {}
        this.lastReload = null;
    }

    debouncedMethod(ms, func, ...args) {
        var timeout;
        return () => {
            if (timeout) clearTimeout(timeout);
            timeout = setTimeout( () => { timeout = null; func.apply(this, args); }, ms);
        }
    }
}