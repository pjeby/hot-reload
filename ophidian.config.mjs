import Builder from "@ophidian/build";

new Builder("hot-reload.ts")
.assign({minify: false, sourcemap: false, outfile: "main.js"})
.withSass()
.withInstall()
.build();

