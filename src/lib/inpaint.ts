/**
 * Client-side inpainting algorithm for SapphireEraser.
 *
 * Advanced approach with texture preservation:
 *   1. BFS from boundary inward with COLOR CLUSTERING — prevents
 *      different texture colors (e.g. orange vs black polka dots)
 *      from blending together into muddy averages.
 *   2. Boundary texture extension — copies actual pixel colors from
 *      the nearest boundary source to preserve patterns.
 *   3. Multi-pass refinement with clustered blending.
 *   4. Adaptive texture noise.
 *   5. Feathered boundary blending.
 *
 * Time complexity: O(n) for main passes
 */

export interface ImageDataRGBA {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

// ──────────────────────────────────────────────
//  Main inpainting entry point
// ──────────────────────────────────────────────

export function inpaintDiffusion(
  image: ImageDataRGBA,
  mask: ImageDataRGBA,
  _iterations: number = 200
): ImageDataRGBA {
  const { width: w, height: h } = image;
  const result = new Uint8ClampedArray(image.data);
  const maskArr = new Uint8Array(w * h);

  // 1. Build binary mask
  for (let i = 0; i < w * h; i++) {
    maskArr[i] = mask.data[i * 4] > 128 ? 1 : 0;
  }

  // 2. BFS fill from boundary inward with color clustering
  bfsFillClustered(result, maskArr, w, h);

  // 3. Boundary texture extension — copy colors from nearest source
  boundaryTextureExtension(result, maskArr, w, h);

  // 4. Refinement pass with clustered blending
  refinementPassClustered(result, maskArr, w, h);

  // 5. Add texture noise (single pass)
  addTextureNoise(result, maskArr, w, h, 2.5);

  // 6. Boundary feathering (wider radius for seamless blend)
  blendBoundary(result, maskArr, w, h, 5);

  return { width: w, height: h, data: result };
}

// ──────────────────────────────────────────────
//  Color clustering helper
//  Groups colors by similarity and picks the dominant cluster.
//  This prevents colors from different texture regions (e.g. orange
//  background vs black polka dots) from blending together.
// ──────────────────────────────────────────────

interface ColorSample {
  r: number;
  g: number;
  b: number;
  weight: number;
}

/**
 * Given a set of neighbor colors, cluster them by similarity
 * and return the weighted average of the dominant cluster.
 * Returns null if no valid cluster found.
 */
function clusterAndAverage(
  colors: ColorSample[],
  threshold: number = 50
): { r: number; g: number; b: number } | null {
  if (colors.length === 0) return null;

  // Simple greedy clustering
  const groups: ColorSample[][] = [];
  const assigned = new Uint8Array(colors.length);

  for (let i = 0; i < colors.length; i++) {
    if (assigned[i]) continue;
    const group: ColorSample[] = [colors[i]];
    assigned[i] = 1;

    for (let j = i + 1; j < colors.length; j++) {
      if (assigned[j]) continue;
      const dr = colors[i].r - colors[j].r;
      const dg = colors[i].g - colors[j].g;
      const db = colors[i].b - colors[j].b;
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);
      if (dist < threshold) {
        group.push(colors[j]);
        assigned[j] = 1;
      }
    }
    groups.push(group);
  }

  // Find largest group by total weight
  let bestGroup = groups[0];
  let bestWeight = 0;
  for (const group of groups) {
    let groupWeight = 0;
    for (const c of group) groupWeight += c.weight;
    if (groupWeight > bestWeight) {
      bestWeight = groupWeight;
      bestGroup = group;
    }
  }

  // Weighted average within the dominant cluster
  let tr = 0, tg = 0, tb = 0, tw = 0;
  for (const c of bestGroup) {
    tr += c.r * c.weight;
    tg += c.g * c.weight;
    tb += c.b * c.weight;
    tw += c.weight;
  }

  if (tw === 0) return null;
  return { r: tr / tw, g: tg / tw, b: tb / tw };
}

// ──────────────────────────────────────────────
//  BFS Fill with Color Clustering
//  Instead of averaging ALL neighbours (which blends orange + black
//  into brown), we cluster similar neighbours and average only within
//  the dominant cluster. This preserves texture boundaries.
// ──────────────────────────────────────────────

function bfsFillClustered(
  img: Uint8ClampedArray,
  mask: Uint8Array,
  w: number,
  h: number
): void {
  const filled = new Float32Array(w * h * 3);
  const isFilled = new Uint8Array(w * h);

  // Seed: all non-masked pixels are already "filled"
  for (let i = 0; i < w * h; i++) {
    if (mask[i] === 0) {
      filled[i * 3] = img[i * 4];
      filled[i * 3 + 1] = img[i * 4 + 1];
      filled[i * 3 + 2] = img[i * 4 + 2];
      isFilled[i] = 1;
    }
  }

  // BFS queue: start with masked pixels adjacent to non-masked
  const queue: number[] = [];
  const inQueue = new Uint8Array(w * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (mask[idx] === 0) continue;

      let isBoundary = false;
      for (const [dy, dx] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const ny = y + dy, nx = x + dx;
        if (ny >= 0 && ny < h && nx >= 0 && nx < w && mask[ny * w + nx] === 0) {
          isBoundary = true;
          break;
        }
      }

      if (isBoundary) {
        queue.push(idx);
        inQueue[idx] = 1;
      }
    }
  }

  // Process BFS — each pixel visited exactly once
  const neighbours: [number, number, number][] = [
    [-1, 0, 1.0], [1, 0, 1.0], [0, -1, 1.0], [0, 1, 1.0],
    [-1, -1, 0.6], [-1, 1, 0.6], [1, -1, 0.6], [1, 1, 0.6]
  ];

  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++];
    const x = idx % w;
    const y = (idx - x) / w;

    // Collect filled neighbor colors
    const colorSamples: ColorSample[] = [];

    for (const [dy, dx, weight] of neighbours) {
      const ny = y + dy, nx = x + dx;
      if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
      const nIdx = ny * w + nx;

      if (isFilled[nIdx]) {
        colorSamples.push({
          r: filled[nIdx * 3],
          g: filled[nIdx * 3 + 1],
          b: filled[nIdx * 3 + 2],
          weight
        });
      }
    }

    // Cluster and average — prevents color bleeding across texture boundaries
    const result = clusterAndAverage(colorSamples, 55);

    if (result) {
      filled[idx * 3] = result.r;
      filled[idx * 3 + 1] = result.g;
      filled[idx * 3 + 2] = result.b;
      isFilled[idx] = 1;

      img[idx * 4] = Math.round(result.r);
      img[idx * 4 + 1] = Math.round(result.g);
      img[idx * 4 + 2] = Math.round(result.b);
      img[idx * 4 + 3] = 255;
    }

    // Add unvisited masked neighbours
    for (const [dy, dx] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const ny = y + dy, nx = x + dx;
      if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
      const nIdx = ny * w + nx;
      if (mask[nIdx] === 1 && !inQueue[nIdx]) {
        queue.push(nIdx);
        inQueue[nIdx] = 1;
      }
    }
  }
}

// ──────────────────────────────────────────────
//  Boundary Texture Extension
//  For each masked pixel, find the nearest non-masked pixel and
//  copy its color. This preserves actual texture patterns (polka dots,
//  stripes, fabric weave) instead of averaging them away.
//  Then blend with the BFS result for smooth transitions.
// ──────────────────────────────────────────────

function boundaryTextureExtension(
  img: Uint8ClampedArray,
  mask: Uint8Array,
  w: number,
  h: number
): void {
  // BFS from non-masked pixels inward to find nearest source for each masked pixel
  const nearestSrcIdx = new Int32Array(w * h);
  nearestSrcIdx.fill(-1);

  const found = new Uint8Array(w * h);
  const queue: number[] = [];

  // Initialize: non-masked pixels are their own source
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (mask[idx] === 0) {
        nearestSrcIdx[idx] = idx;
        found[idx] = 1;

        // Add masked neighbors to queue
        for (const [dy, dx] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          const ny = y + dy, nx = x + dx;
          if (ny >= 0 && ny < h && nx >= 0 && nx < w) {
            const nIdx = ny * w + nx;
            if (mask[nIdx] === 1 && !found[nIdx]) {
              queue.push(nIdx);
              found[nIdx] = 1;
            }
          }
        }
      }
    }
  }

  // BFS: propagate nearest source index
  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++];
    const x = idx % w;
    const y = (idx - x) / w;

    // Find which neighbor has the closest source
    let bestDist = Infinity;
    let bestSrc = -1;

    for (const [dy, dx] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const ny = y + dy, nx = x + dx;
      if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
      const nIdx = ny * w + nx;
      if (nearestSrcIdx[nIdx] >= 0) {
        const srcIdx = nearestSrcIdx[nIdx];
        const srcX = srcIdx % w;
        const srcY = (srcIdx - srcX) / w;
        const dist = (x - srcX) * (x - srcX) + (y - srcY) * (y - srcY);
        if (dist < bestDist) {
          bestDist = dist;
          bestSrc = srcIdx;
        }
      }
    }

    nearestSrcIdx[idx] = bestSrc;

    // Add unvisited masked neighbors
    for (const [dy, dx] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const ny = y + dy, nx = x + dx;
      if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
      const nIdx = ny * w + nx;
      if (mask[nIdx] === 1 && !found[nIdx]) {
        queue.push(nIdx);
        found[nIdx] = 1;
      }
    }
  }

  // Now compute "extended" source positions.
  // For each masked pixel P at distance d from boundary pixel B,
  // we look at a position further into the non-masked area from B
  // by the same direction. This effectively mirrors the boundary
  // texture pattern into the masked region.
  const bfsResult = new Uint8ClampedArray(img); // save BFS result

  for (let i = 0; i < w * h; i++) {
    if (mask[i] === 0 || nearestSrcIdx[i] < 0) continue;

    const x = i % w;
    const y = (i - x) / w;
    const srcIdx = nearestSrcIdx[i];
    const srcX = srcIdx % w;
    const srcY = (srcIdx - srcX) / w;

    // Direction from source to this pixel
    const dx = x - srcX;
    const dy = y - srcY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 0.5) continue;

    // Normalize direction
    const ndx = dx / dist;
    const ndy = dy / dist;

    // Try multiple extension distances to find a valid source pixel
    // Start with the boundary pixel itself, then try extending further
    let bestColor: number[] | null = null;

    // Try extending 1-3 pixels into the non-masked area from the boundary source
    for (const offset of [0, 1, 2, 3, 5, 8]) {
      const extX = Math.round(srcX - ndx * offset);
      const extY = Math.round(srcY - ndy * offset);
      if (extX >= 0 && extX < w && extY >= 0 && extY < h) {
        const extIdx = extY * w + extX;
        if (mask[extIdx] === 0) {
          bestColor = [
            bfsResult[extIdx * 4],
            bfsResult[extIdx * 4 + 1],
            bfsResult[extIdx * 4 + 2]
          ];
          break;
        }
      }
    }

    if (bestColor) {
      // Blend: use more texture extension color when far from boundary,
      // more BFS color when close (to avoid harsh edges near boundary)
      const blendFactor = Math.min(0.75, 0.3 + dist * 0.05);

      img[i * 4] = Math.round(bfsResult[i * 4] * (1 - blendFactor) + bestColor[0] * blendFactor);
      img[i * 4 + 1] = Math.round(bfsResult[i * 4 + 1] * (1 - blendFactor) + bestColor[1] * blendFactor);
      img[i * 4 + 2] = Math.round(bfsResult[i * 4 + 2] * (1 - blendFactor) + bestColor[2] * blendFactor);
    }
  }
}

// ──────────────────────────────────────────────
//  Refinement pass with color clustering
//  Uses a wider 5x5 neighborhood with distance-based weighting.
//  Color clustering prevents cross-texture blending.
// ──────────────────────────────────────────────

function refinementPassClustered(
  img: Uint8ClampedArray,
  mask: Uint8Array,
  w: number,
  h: number
): void {
  const temp = new Uint8ClampedArray(img);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      if (mask[idx] === 0) continue;

      const colorSamples: ColorSample[] = [];

      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
          const nIdx = ny * w + nx;

          const dist = Math.abs(dx) + Math.abs(dy);
          const isOriginal = mask[nIdx] === 0;

          const distWeight = dist === 0 ? 1.0 : 1.0 / dist;
          const originalBonus = isOriginal ? 3.0 : 1.0;
          const weight = distWeight * originalBonus;

          colorSamples.push({
            r: temp[nIdx * 4],
            g: temp[nIdx * 4 + 1],
            b: temp[nIdx * 4 + 2],
            weight
          });
        }
      }

      const result = clusterAndAverage(colorSamples, 50);

      if (result) {
        img[idx * 4] = Math.round(result.r);
        img[idx * 4 + 1] = Math.round(result.g);
        img[idx * 4 + 2] = Math.round(result.b);
      }
    }
  }
}

// ──────────────────────────────────────────────
//  Texture noise (adaptive, single pass)
// ──────────────────────────────────────────────

function addTextureNoise(
  img: Uint8ClampedArray,
  mask: Uint8Array,
  w: number,
  h: number,
  strength: number
): void {
  let seed = 42;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed / 2147483647) * 2 - 1;
  };

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      if (mask[idx] === 0) continue;

      // Quick local variance from 3x3 neighbourhood
      let sumR = 0, sumG = 0, sumB = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nIdx = (y + dy) * w + (x + dx);
          sumR += img[nIdx * 4];
          sumG += img[nIdx * 4 + 1];
          sumB += img[nIdx * 4 + 2];
        }
      }
      const avgR = sumR / 9, avgG = sumG / 9, avgB = sumB / 9;
      let variance = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nIdx = (y + dy) * w + (x + dx);
          variance += (img[nIdx * 4] - avgR) ** 2
                    + (img[nIdx * 4 + 1] - avgG) ** 2
                    + (img[nIdx * 4 + 2] - avgB) ** 2;
        }
      }
      const localStd = Math.sqrt(variance / 27);

      // Scale noise to local texture — less noise for smooth areas, more for textured
      const noiseScale = Math.max(0.3, Math.min(localStd * 0.4, strength * 1.5));

      img[idx * 4] = Math.max(0, Math.min(255, Math.round(img[idx * 4] + rand() * noiseScale)));
      img[idx * 4 + 1] = Math.max(0, Math.min(255, Math.round(img[idx * 4 + 1] + rand() * noiseScale)));
      img[idx * 4 + 2] = Math.max(0, Math.min(255, Math.round(img[idx * 4 + 2] + rand() * noiseScale)));
    }
  }
}

// ──────────────────────────────────────────────
//  Boundary blending (single pass, feathered)
//  Wider radius with stronger original-pixel weight for seamless edges.
// ──────────────────────────────────────────────

function blendBoundary(
  img: Uint8ClampedArray,
  mask: Uint8Array,
  w: number,
  h: number,
  radius: number
): void {
  const temp = new Uint8ClampedArray(img);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (mask[idx] === 0) continue;

      // Quick check: is this near the boundary?
      let nearEdge = false;
      const checkR = Math.min(radius, 4);
      outer:
      for (let dy = -checkR; dy <= checkR; dy++) {
        for (let dx = -checkR; dx <= checkR; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny >= 0 && ny < h && nx >= 0 && nx < w && mask[ny * w + nx] === 0) {
            nearEdge = true;
            break outer;
          }
        }
      }

      if (!nearEdge) continue;

      // Gather colors with clustered blending for boundary pixels
      const colorSamples: ColorSample[] = [];

      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;

          const dist = Math.abs(dx) + Math.abs(dy);
          if (dist > radius * 2) continue;

          const nIdx = ny * w + nx;
          const isOriginal = mask[nIdx] === 0;
          const weight = isOriginal
            ? 3.0 * Math.exp(-dist * 0.35)
            : Math.exp(-dist * 0.35);

          colorSamples.push({
            r: temp[nIdx * 4],
            g: temp[nIdx * 4 + 1],
            b: temp[nIdx * 4 + 2],
            weight
          });
        }
      }

      const result = clusterAndAverage(colorSamples, 45);

      if (result) {
        img[idx * 4] = Math.round(result.r);
        img[idx * 4 + 1] = Math.round(result.g);
        img[idx * 4 + 2] = Math.round(result.b);
      }
    }
  }
}

// ──────────────────────────────────────────────
//  Utility functions (compatibility)
// ──────────────────────────────────────────────

export function extractMaskFromCanvas(
  maskCanvas: HTMLCanvasElement
): ImageDataRGBA {
  const ctx = maskCanvas.getContext("2d")!;
  const imgData = ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
  const maskData = new Uint8ClampedArray(imgData.data.length);

  for (let i = 0; i < imgData.data.length; i += 4) {
    const isMasked = imgData.data[i + 3] > 30;
    maskData[i] = isMasked ? 255 : 0;
    maskData[i + 1] = isMasked ? 255 : 0;
    maskData[i + 2] = isMasked ? 255 : 0;
    maskData[i + 3] = 255;
  }

  return { width: maskCanvas.width, height: maskCanvas.height, data: maskData };
}

export function compositeResult(
  original: ImageDataRGBA,
  inpainted: ImageDataRGBA,
  mask: ImageDataRGBA
): ImageDataRGBA {
  const result = new Uint8ClampedArray(original.data);

  for (let i = 0; i < original.width * original.height; i++) {
    if (mask.data[i * 4] > 128) {
      result[i * 4] = inpainted.data[i * 4];
      result[i * 4 + 1] = inpainted.data[i * 4 + 1];
      result[i * 4 + 2] = inpainted.data[i * 4 + 2];
      result[i * 4 + 3] = 255;
    }
  }

  return { width: original.width, height: original.height, data: result };
}

export function putImageDataRGBA(
  canvas: HTMLCanvasElement,
  imgData: ImageDataRGBA
): void {
  const ctx = canvas.getContext("2d")!;
  const clamped = new ImageData(imgData.data, imgData.width, imgData.height);
  canvas.width = imgData.width;
  canvas.height = imgData.height;
  ctx.putImageData(clamped, 0, 0);
}
