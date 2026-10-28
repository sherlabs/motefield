// Copies the onnxruntime-web wasm runtime into public/ort so the app never
// depends on a CDN at runtime.
import { cpSync, mkdirSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "onnxruntime-web", "dist");
const dst = join(root, "public", "ort");

if (!existsSync(src)) {
  console.warn("[copy-ort] onnxruntime-web not installed yet, skipping");
  process.exit(0);
}
mkdirSync(dst, { recursive: true });
const wanted = readdirSync(src).filter(
  (f) =>
    f === "ort.wasm.min.js" ||
    (/^ort-wasm.*\.wasm$/.test(f) && !f.includes("training") && !f.includes("jsep") && !f.includes("threaded")),
);
for (const f of wanted) cpSync(join(src, f), join(dst, f));
// MIT requires the notice to travel with redistributed copies.
const lic = join(root, "node_modules", "onnxruntime-web", "LICENSE");
if (existsSync(lic)) cpSync(lic, join(dst, "LICENSE"));
else
  writeFileSync(
    join(dst, "LICENSE"),
    "onnxruntime-web 1.17.3\nCopyright (c) Microsoft Corporation. All rights reserved.\nLicensed under the MIT License: https://github.com/microsoft/onnxruntime/blob/main/LICENSE\n",
  );
console.log(`[copy-ort] copied ${wanted.length} files to public/ort`);
