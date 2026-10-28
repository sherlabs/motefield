# Third-party notices

Motefield itself is MIT licensed (see LICENSE). It depends on, redistributes or fetches the following components.

## Fetched at runtime (not redistributed in this repository)

| Component | Licence | Source |
|---|---|---|
| Depth Anything V2 Small, quantized ONNX export by onnx-community | Apache-2.0 | https://huggingface.co/onnx-community/depth-anything-v2-small |
| MODNet portrait matting, ONNX export by Xenova (original model by ZHKKKe) | Apache-2.0 | https://huggingface.co/Xenova/modnet and https://github.com/ZHKKKe/MODNet |
| Manrope typeface (self-hosted at build time through next/font) | SIL Open Font License 1.1 | https://github.com/sharanda/manrope |

## Redistributed in builds

| Component | Licence | Source |
|---|---|---|
| onnxruntime-web 1.17.3 wasm runtime, copied into public/ort by scripts/copy-ort.mjs together with its LICENSE | MIT, Copyright (c) Microsoft Corporation | https://github.com/microsoft/onnxruntime |

## npm dependencies

| Component | Licence | Source |
|---|---|---|
| Next.js, React, React DOM | MIT | https://github.com/vercel/next.js, https://github.com/facebook/react |
| mp4-muxer, webm-muxer | MIT | https://github.com/Vanilagy/mp4-muxer, https://github.com/Vanilagy/webm-muxer |
| onnxruntime-web | MIT | https://github.com/microsoft/onnxruntime |
| TypeScript, ESLint, eslint-config-next, @types/* (development only) | Apache-2.0 / MIT | respective repositories |
