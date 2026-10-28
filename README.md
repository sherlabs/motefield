# Motefield

**Turn pictures into living particle fields. Export loops for the web.**

Motefield takes up to four pictures and turns each into a field of 524,288 motes with relief read from a depth model, then lets you export the moving result as a seamless video loop, a poster frame and an embed snippet. Everything runs in the browser: no picture, model input or video ever leaves your machine.

> Home: https://github.com/sherlabs/motefield. The package is marked `private` until a decision is made about publishing to npm.

## Features

- WebGL2 renderer drawing 524,288 motes at 60 fps on a laptop GPU, with no vertex buffers: every mote reads its home from a float texture.
- Depth-driven relief from **Depth Anything V2 Small**, run locally in a Web Worker with onnxruntime-web (wasm).
- **Remove background** per picture with **MODNet** portrait matting (soft alpha matte, edge decontamination), with a depth-based cut as the fallback. Pictures with transparency or a dark ground skip the model.
- True-colour mode (motes carry the picture's own sRGB colours) or an inverted, glowing-dust look; dark or paper backgrounds.
- Wind, scatter, cohesion and relief controls; a **shore** line that decides where the field frays into the wind; flock and flow transitions between pictures; flashes of coloured light; a sweep plane; streaks.
- Tag overlay: corner-bracket tags with coordinate readouts on salient points, a web between neighbours, ruler labels.
- Four procedural sample pictures (comet, moon, eddy, lattice) drawn in code, no assets.
- Export: frame-exact MP4 (H.264) or WebM (VP9) through WebCodecs, MediaRecorder fallback, seamless loop mode, poster PNG, embed snippet. Exports never include the interface.

## How it works

A dropped picture goes through a short pipeline. First the **matte**: MODNet gives a soft alpha for the subject (skipped for pictures with transparency or a dark ground; a depth split stands in when the model is unavailable or unsure), and rim pixels are cleaned of backdrop colour. Then **depth**: Depth Anything V2 gives a relative depth map that is normalised and used only as relief. Then **importance sampling**: every pixel gets a weight from detail, brightness and the matte, the frame is walked along a Z-order curve and 524,288 motes are dropped where the running weight crosses each step, so dense areas get dense motes and dropped background gets none. The motes become two textures (home position + relief, colour) that the **GPU** reads by vertex id; the vertex shader applies breath, wind, flights between pictures, flashes and the pointer wake every frame, with no buffers to update. For **export**, a second renderer with a deterministic clock draws each frame at the chosen time and hands it to WebCodecs, so the loop is frame-exact and the interface is never in it.

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:3000, drop up to four pictures on the page or use the samples. `npm run build && npm start` serves a production build. `npm run lint` and `npm run typecheck` run the checks used in CI.

Keys: Space next · S flash · 1–4 pictures · M flock/flow · B paper · F full screen · H hide the interface. Drag to turn, wheel to zoom, double-click to reset the view.

## How the models load

Model weights are **not** part of this repository. They are fetched at runtime from Hugging Face on first use and cached by the browser:

| Purpose | Model | Licence | Size | Source constant |
|---|---|---|---|---|
| Depth | Depth Anything V2 Small, quantized ONNX (onnx-community) | Apache-2.0 | ~25 MB | `MODEL_URL` in `src/lib/depth/worker.ts` |
| Background | MODNet portrait matting, ONNX export by Xenova (original by ZHKKKe) | Apache-2.0 | ~26 MB | `MATTE_MODEL_URL` in `src/lib/matte/worker.ts` |

Both run in dedicated Web Workers on the wasm execution provider of onnxruntime-web. The runtime itself is copied from `node_modules` into `public/ort/` by `scripts/copy-ort.mjs` on install, dev and build, so nothing is loaded from a CDN. Point the URL constants at your own host (or a file under `public/`) to self-host the weights.

Fallbacks: if the depth model cannot load, relief comes from smoothed luminance. If the matting model cannot load, stalls (no bytes for 20 s) or is not confident about a picture, the backdrop is cut by an adaptive split of the depth map. The top bar shows which path is active.

## Export

Press **Export** in the top bar. Choose a size (720p, 1080p, square 1080, vertical 1080×1920), frame rate (24/30/60), length (3–30 s) and options:

- **Seamless loop**: the loop length is set to the video length and every animation is quantised to it, so the last frame flows into the first.
- **All pictures**: cycle through every loaded picture instead of the one on screen.

Frames are rendered offline on a private renderer with a deterministic clock, so the result is frame-exact whatever the machine speed, and the live view is untouched. You get a preview, `motefield-<timestamp>.mp4|webm`, a poster PNG and an embed snippet:

```html
<video src="motefield.mp4" poster="motefield-poster.png" autoplay muted loop playsinline preload="metadata" style="width:100%;height:auto"></video>
```

`muted` and `playsinline` are needed for autoplay on mobile browsers.

### Browser support

- WebGL2 is required to view or export anything.
- Best path: WebCodecs (Chrome and Edge 94+, Safari 16.4+). H.264 MP4 where the encoder allows, otherwise VP9 WebM. Faster than realtime.
- Fallback: `canvas.captureStream` plus MediaRecorder (for example current Firefox). Captures in realtime, so the tab must stay visible.
- Depth and matting need WebAssembly; the wasm runtime is single-threaded so it works without cross-origin isolation.

## Limitations

- Pointer wakes, orbiting and hand-fired flashes are interactive only; they are not part of exports (FLASH AUTO adds scheduled flashes that are).
- Very large sizes at 60 fps may exceed the hardware H.264 level on some devices; the exporter then falls back to VP9 WebM.
- MODNet is a portrait matter. On non-portrait pictures the matte is rejected by a plausibility check and the depth cut is used instead.
- Pictures are fitted into a 1024×1024 working frame; larger pictures are downscaled.

## Roadmap

- Adaptive mote count for slower GPUs.
- Guided filtering of the depth map against the picture for crisper relief.
- A general-purpose segmentation model as an alternative to the portrait matter.
- Audio-reactive flashes.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Please follow the [code of conduct](CODE_OF_CONDUCT.md). Security issues: [SECURITY.md](SECURITY.md).

## Licence

MIT, see [LICENSE](LICENSE). Third-party components and the models fetched at runtime are listed with their licences in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Acknowledgements

The idea of depth-driven particle portraits is shared with a number of interactive web pieces, including Gather by DAO. Motefield is an independent codebase with its own renderer, shaders, interface and pipeline, and is not affiliated with or endorsed by any of them.
