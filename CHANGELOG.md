# Changelog

### 0.2.2 (Unreleased)
- Fix errors when a watched plugin is deleted on disk
- Update build target to ES2021

### 0.2.1 (2025-03-09)
- Add change log
- Don't reload unless files are actually changed (fixes an issue where sync tools reading plugin files could trigger a reload)
- Add donation link, per request (Fix [#25](https://github.com/pjeby/hot-reload/issues/25))
- Don't track versions of files other than main.js and styles.css, as other files don't need to trigger reloads
- Don't scan all plugins for every vault change event

### 0.2.0 (2025-02-01)
- Document symlink support
- Added experimental source-stripping prevention for Obsidian 1.6+

### 0.1.15 (2024-12-28)
- Improved mobile platform handling

### 0.1.14 (2024-12-14)
- Improved mobile support

### 0.1.13 (2024-10-15)
- Fix symlinked plugins not working on desktop

### 0.1.12 (2024-10-06)
- Experimental mobile support
- Document mobile alternatives

### 0.1.11 (2024-03-05)
- Don't throw an error for uninstalled plugins
- Fix issue using non-default configDir ([#8](https://github.com/pjeby/hot-reload/issues/8), [#9](https://github.com/pjeby/hot-reload/pull/9))
- Add license (fix [#5](https://github.com/pjeby/hot-reload/issues/5))
- Improve reloading selectivity:
  - Avoid race conditions and multiple reloads
  - Don't reload disabled plugins

### 0.1.10 (2022-09-03)
- Add a manual reload command for use in sandboxes

### 0.1.9 (2022-03-16)
- Enable sourcemaps in Obsidian 0.14+

  In Obsidian 14 and above, sourcemaps are stripped from plugins
  at load time unless the "debug plugin startup" setting is on.
  Hot Reload now automatically switches that option on when
  reloading a plugin, so you get sourcemaps while developing,
  without needing to keep the debug setting on all the time
  (or sourcemaps in memory all the time).

### 0.1.8 (2021-05-25)
- Support symlinked plugins on Windows and OSX

### 0.1.7 (2021-04-06)
- Support configurable .obsidian dir

### 0.1.6 (2021-03-13)
- Don't reload plugins while app is loading

### 0.1.5 (2021-02-14)
- Detect new plugins and newly-reloadable plugins

### 0.1.4 (2021-02-14)
- Don't start new watches on Linux after every scan

### 0.1.3 (2021-02-14)
- Draft Linux support

### 0.1.2 (2021-02-03)
- Add Notice on reload; improved install docs

### 0.1.1 (2021-01-31)
- Simplified release script
- Properly serialize plugin loading

### 0.1.0 (2021-01-30)
- Initial release
