// Port-owned client bundler for the iMac standalone server.
//
// This is NOT the Hatch builder: it builds this port's own client bundle
// (client/dist) served by server/src/standalone.ts. It replicates the
// SDK's Bun.build configuration (entry, outdir, minify, NODE_ENV,
// naming, tailwind plugin, asset-URL re-prefix) from
// @hatch/space-sdk/build, which is public in the SDK source. It does not
// touch the SDK, does not set HATCH_SPACES_BUILD_DRIVER, and does not
// publish anything to the Muse artifact — the Muse copy is built only
// through artifact.edit.
import { rm } from "node:fs/promises";
import { basename } from "node:path";
import tailwindPlugin from "bun-plugin-tailwind";

const ENTRY = "./client/index.html";
const OUTDIR = "./client/dist";

if (typeof Bun === "undefined" || typeof Bun.build !== "function") {
  throw new Error("build-standalone.mjs must run under Bun");
}

await rm(OUTDIR, { force: true, recursive: true });
const result = await Bun.build({
  entrypoints: [ENTRY],
  outdir: OUTDIR,
  minify: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  naming: {
    asset: "assets/[name]-[hash].[ext]",
    chunk: "assets/[name]-[hash].[ext]",
    entry: "[name].[ext]",
  },
  plugins: [tailwindPlugin],
});
if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  throw new Error("standalone client build failed; see logged diagnostics");
}
// Bun writes imported assets to `assets/<name>-<hash>.<ext>` but emits the
// JS/CSS import URL as a bare `./<name>-<hash>.<ext>`. Re-prefix only the
// bare imported-asset URLs to `./assets/...` (same fix as the SDK build).
const assetFiles = result.outputs
  .filter((output) => output.kind === "asset")
  .map((output) => basename(output.path));
for (const output of result.outputs) {
  if (!/\.(js|css|html)$/.test(output.path)) continue;
  let text = await output.text();
  let changed = false;
  for (const name of assetFiles) {
    const bare = `./${name}`;
    if (text.includes(bare)) {
      text = text.split(bare).join(`./assets/${name}`);
      changed = true;
    }
  }
  if (changed) await Bun.write(output.path, text);
}
console.log(
  `standalone client build ok: ${result.outputs.length} outputs -> ${OUTDIR}`,
);
