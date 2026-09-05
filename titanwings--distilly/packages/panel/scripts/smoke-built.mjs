import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await import("@distilly/panel/server");
const web = await import("@distilly/panel/web");

assert.deepEqual(Object.keys(server).sort(), ["PanelLauncher", "startPanelServer"]);
assert.deepEqual(Object.keys(web).sort(), ["HttpEngineClient", "bootstrapPanel"]);

const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
const css = await readFile(new URL("../web/app.css", import.meta.url), "utf8");
const js = await readFile(new URL("../web/app.js", import.meta.url));
assert.match(html, /<script type="module" src="\/app\.js"><\/script>/u);
assert.match(html, /<link rel="stylesheet" href="\/app\.css" \/>/u);
assert.ok(css.length > 0);
assert.ok(js.byteLength > 0);
