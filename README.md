# SapphireEraser v3

Client-side AI object removal tool. No server, no API — all processing happens in your browser.

## Algorithm

BFS diffusion inpainting with **color clustering** — the algorithm that works:

1. **BFS fill with color clustering** — fills from boundary inward, clustering similar colors to prevent muddy blending (e.g. orange + black polka dots don't become brown)
2. **Boundary texture extension** — copies actual pixel patterns from nearest boundary source, preserving textures (fabric, bark, grain)
3. **Clustered refinement pass** — 5x5 neighborhood with distance-weighted clustering
4. **Adaptive texture noise** — adds subtle noise scaled to local variance (more for textured areas, less for smooth)
5. **Feathered boundary blend** — smooth transition at mask edges

## Features

- Paint mask over unwanted object
- One-click erase
- Undo/redo (30 steps)
- Zoom & pan (scroll + space)
- Brush & eraser tools
- Download result as PNG
- All processing 100% client-side — images never leave your device

## Tech Stack

- Next.js 16 + React 19
- Tailwind CSS 4
- TypeScript
- Canvas API for image processing
- BFS + color clustering algorithm (616 lines, deterministic)

## Development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## Version History

- **v3** (frozen) — BFS diffusion + color clustering + texture extension. Best quality for most cases.
- v2 — Simple BFS fill (no clustering, muddy on multi-color textures)
- v1 — Iterative diffusion (slow, 20 passes)

## License

Private repository. All rights reserved.

## Author

Alex Vive
