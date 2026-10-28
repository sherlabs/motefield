# Contributing to Motefield

Thanks for taking an interest. Motefield is small enough that most changes fit in one pull request.

## Set up

```bash
npm install
npm run dev
```

The app runs at http://localhost:3000. `npm run lint`, `npm run typecheck` and `npm run build` are what CI runs; please make sure all three pass before opening a pull request.

## Where things live

- `src/lib/gl/` renderer and GLSL shaders (every mote reads its home from float textures by vertex id)
- `src/lib/scene/` picture to mote placement (importance sampling), sample pictures
- `src/lib/depth/`, `src/lib/matte/` the depth and matting workers and their main-thread clients
- `src/lib/hud/` the tag overlay drawn on a 2D canvas
- `src/lib/export/` frame-exact video and poster export
- `src/components/` the React shell

## Guidelines

- Keep the renderer a pure function of (parameters, scenes, time) except for the clearly marked interactive state, so exports stay frame-exact.
- Anything time-based must stay periodic over the loop length (see `rate()` in the vertex shader and `quant()` in the renderer).
- No external assets: sample pictures are drawn in code, models are fetched at runtime and are not committed.
- Only add dependencies with permissive licences and record them in `THIRD_PARTY_NOTICES.md`.
- Describe what you changed and why in the pull request; screenshots or a short clip help for anything visual.

## Reporting bugs

Use the issue templates. Include the browser, GPU if you know it, and whether WebCodecs was available (the export panel says so).
