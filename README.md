# SapphireEraser v3 ✨

**Local tool for removing objects from images.**  
Processing runs entirely on your device — accessed via browser.

## Purpose
Designed primarily for removing objects on **white or uniform backgrounds**.

## Algorithm
- **BFS diffusion with color clustering** — fills from the boundary inward, grouping similar colors
- Refinement iteration with clustering — 5×5 neighborhood with distance weighting
- Adaptive texture noise — subtle noise scaled to local variance
- Smooth boundary blending — soft transition at processing edges

## Features
- Undo/redo (30 steps)
- Zoom & pan (scroll + space)
- Brush tool
- Download result as PNG
- **100% client-side processing** — images never leave your device

## Tech Stack
- Next.js 16 + React 19
- Tailwind CSS 4
- TypeScript
- Browser APIs for image processing
- BFS + color clustering algorithm (616 lines, deterministic)

## Development

```bash
npm install
npm run dev
```
Public repository for portfolio purposes. All rights reserved. Unauthorized commercial use prohibited.
## License
## Author

Alex Vive

*Cherchez le chic* ✨
