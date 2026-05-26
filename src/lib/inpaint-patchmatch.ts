/**
 * PatchMatch-lite inpainting algorithm for SapphireEraser.
 *
 * Replaces the old BFS approach (which was a low-pass filter that
 * destroyed texture via clusterAndAverage) with patch-based texture
 * copying that preserves real patterns.
 *
 * How it works:
 *   1. For each masked pixel, search the non-masked area for the best
 *      matching 5x5 patch (comparing known pixels that overlap the boundary).
 *   2. Copy the center pixel from the best matching patch.
 *   3. Run 2-3 iterations with NNF propagation between iterations.
 *   4. Light boundary blend for seamless transition.
 *
 * Performance optimizations:
 *   - Early termination in patch distance when exceeding best known distance
 *   - NNF (Nearest Neighbor Field) carried between iterations
 *   - Seeded PRNG for reproducible, fast random sampling
 *   - Adaptive search radius based on mask size
 *   - Skip already-perfect matches (dist < threshold)
 *
 * Based on the PatchMatch algorithm (Barnes et al., 2009) simplified
 * for client-side browser inpainting.
 */

export interface ImageDataRGBA {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

// ──────────────────────────────────────────────
//  Configuration
// ──────────────────────────────────────────────

const PATCH_SIZE = 5;               // 5x5 patches
const PATCH_RADIUS = Math.floor(PATCH_SIZE / 2); // = 2
const BOUNDARY_BLEND_RADIUS = 4;    // Feathering radius at mask edge
const EARLY_TERM_THRESHOLD = 50;    // If patch distance < this, accept immediately

// ──────────────────────────────────────────────
//  Seeded PRNG (fast, deterministic)
// ──────────────────────────────────────────────

function createRNG(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xFFFFFFFF;
    return (s >>> 0) / 0xFFFFFFFF;
  };
}

// ──────────────────────────────────────────────
//  Main entry point
// ──────────────────────────────────────────────

export function patchMatchInpaint(
  image: ImageDataRGBA,
  mask: ImageDataRGBA
): ImageDataRGBA {
  const { width: w, height: h } = image;
  const result = new Uint8ClampedArray(image.data);

  // Build binary mask (1 = masked/erased, 0 = keep)
  const maskArr = new Uint8Array(w * h);
  let maskCount = 0;
  for (let i = 0; i < w * h; i++) {
    if (mask.data[i * 4] > 128) {
      maskArr[i] = 1;
      maskCount++;
    }
  }

  // Skip if nothing to inpaint
  if (maskCount === 0) return { width: w, height: h, data: result };

  // Adaptive configuration based on mask size
  const iterations = maskCount > 50000 ? 2 : 3;
  const searchRadius = Math.min(60, Math.max(20, Math.round(Math.sqrt(maskCount) * 0.8)));
  const randomSamples = maskCount > 50000 ? 16 : 24;

  // Step 1: Initialize masked pixels with nearest-neighbor copy
  // This gives PatchMatch something to compare against for interior pixels
  initializeFromNearest(result, maskArr, w, h);

  // Step 2: Build NNF and run PatchMatch iterations
  const nnf = new Int32Array(w * h).fill(-1);

  for (let iter = 0; iter < iterations; iter++) {
    patchMatchIteration(result, maskArr, w, h, iter, nnf, searchRadius, randomSamples);
  }

  // Step 3: Boundary blending for seamless transition
  blendBoundary(result, maskArr, w, h, BOUNDARY_BLEND_RADIUS);

  return { width: w, height: h, data: result };
}

// ──────────────────────────────────────────────
//  Initialize masked pixels by copying from
//  nearest non-masked pixel (better than averaging)
// ──────────────────────────────────────────────

function initializeFromNearest(
  img: Uint8ClampedArray,
  mask: Uint8Array,
  w: number,
  h: number
): void {
  // BFS from non-masked pixels to find nearest source for each masked pixel
  const nearestSrc = new Int32Array(w * h).fill(-1);
  const dist = new Float32Array(w * h).fill(Infinity);
  const queue: number[] = [];

  // Seed: non-masked pixels are their own nearest source
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (mask[idx] === 0) {
        nearestSrc[idx] = idx;
        dist[idx] = 0;
        queue.push(idx);
      }
    }
  }

  // BFS: propagate nearest source index
  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++];
    const x = idx % w;
    const y = (idx - x) / w;

    for (const [dy, dx] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const ny = y + dy, nx = x + dx;
      if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
      const nIdx = ny * w + nx;
      const newDist = dist[idx] + 1;
      if (newDist < dist[nIdx]) {
        dist[nIdx] = newDist;
        nearestSrc[nIdx] = nearestSrc[idx];
        queue.push(nIdx);
      }
    }
  }

  // Copy color from nearest non-masked source
  for (let i = 0; i < w * h; i++) {
    if (mask[i] === 0 || nearestSrc[i] < 0) continue;
    const srcIdx = nearestSrc[i];
    img[i * 4] = img[srcIdx * 4];
    img[i * 4 + 1] = img[srcIdx * 4 + 1];
    img[i * 4 + 2] = img[srcIdx * 4 + 2];
    img[i * 4 + 3] = 255;
  }
}

// ──────────────────────────────────────────────
//  Patch distance with early termination
//  Sum of Squared Differences (SSD)
//  Only compares pixels where source is NOT masked.
// ──────────────────────────────────────────────

function patchDistance(
  img: Uint8ClampedArray,
  mask: Uint8Array,
  x1: number, y1: number,  // Target position (masked pixel)
  x2: number, y2: number,  // Source position (candidate from non-masked area)
  w: number, h: number,
  maxDist: number           // Early termination threshold
): number {
  let dist = 0;
  let count = 0;

  for (let dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy++) {
    for (let dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx++) {
      const ty = y1 + dy, tx = x1 + dx;
      const sy = y2 + dy, sx = x2 + dx;

      // Both pixels must be in bounds
      if (ty < 0 || ty >= h || tx < 0 || tx >= w) continue;
      if (sy < 0 || sy >= h || sx < 0 || sx >= w) continue;

      // Only compare if source patch pixel is NOT masked
      const srcIdx = sy * w + sx;
      if (mask[srcIdx] === 1) continue;

      const tgtIdx = ty * w + tx;
      // Weight: non-masked target pixels get higher weight (3x)
      const weight = mask[tgtIdx] === 0 ? 3.0 : 1.0;

      const dr = img[tgtIdx * 4] - img[srcIdx * 4];
      const dg = img[tgtIdx * 4 + 1] - img[srcIdx * 4 + 1];
      const db = img[tgtIdx * 4 + 2] - img[srcIdx * 4 + 2];

      dist += (dr * dr + dg * dg + db * db) * weight;
      count++;

      // Early termination: if already worse than best, stop
      if (count >= 5 && dist / count > maxDist) {
        return Infinity;
      }
    }
  }

  if (count < 3) return Infinity;
  return dist / count;
}

// ──────────────────────────────────────────────
//  Find best matching patch for a target pixel
//  1. NNF propagation from neighbors
//  2. Random search with decreasing radius
// ──────────────────────────────────────────────

function findBestPatch(
  img: Uint8ClampedArray,
  mask: Uint8Array,
  tx: number, ty: number,
  w: number, h: number,
  nnf: Int32Array,
  searchRadius: number,
  randomSamples: number,
  rng: () => number
): { x: number; y: number; dist: number } {
  let bestDist = Infinity;
  let bestX = tx, bestY = ty;

  // Helper to test a candidate and update best
  const tryCandidate = (sx: number, sy: number) => {
    if (sx < PATCH_RADIUS || sx >= w - PATCH_RADIUS ||
        sy < PATCH_RADIUS || sy >= h - PATCH_RADIUS) return;
    if (mask[sy * w + sx] === 1) return;

    const d = patchDistance(img, mask, tx, ty, sx, sy, w, h, bestDist);
    if (d < bestDist) {
      bestDist = d;
      bestX = sx;
      bestY = sy;
    }
  };

  // 1. NNF propagation from already-processed neighbors
  // Left neighbor
  if (tx > 0) {
    const leftIdx = ty * w + (tx - 1);
    if (mask[leftIdx] === 1 && nnf[leftIdx] >= 0) {
      const offset = nnf[leftIdx];
      const sx = (offset % w) + 1; // Shift right by 1 to correspond to target
      const sy = Math.floor(offset / w);
      tryCandidate(sx, sy);
    }
  }

  // Top neighbor
  if (ty > 0) {
    const topIdx = (ty - 1) * w + tx;
    if (mask[topIdx] === 1 && nnf[topIdx] >= 0) {
      const offset = nnf[topIdx];
      const sx = offset % w;
      const sy = Math.floor(offset / w) + 1; // Shift down by 1
      tryCandidate(sx, sy);
    }
  }

  // If propagation found a very good match, reduce search
  if (bestDist < EARLY_TERM_THRESHOLD) {
    return { x: bestX, y: bestY, dist: bestDist };
  }

  // 2. Random search within decreasing radius
  let searchR = searchRadius;
  const alpha = 0.5;

  while (searchR >= 2) {
    const samplesAtLevel = Math.max(4, Math.floor(randomSamples * (searchR / searchRadius)));
    for (let attempt = 0; attempt < samplesAtLevel; attempt++) {
      const sx = tx + Math.round((rng() * 2 - 1) * searchR);
      const sy = ty + Math.round((rng() * 2 - 1) * searchR);
      tryCandidate(sx, sy);
    }
    searchR = Math.floor(searchR * alpha);
  }

  return { x: bestX, y: bestY, dist: bestDist };
}

// ──────────────────────────────────────────────
//  Single PatchMatch iteration
//  Process masked pixels from boundary inward.
// ──────────────────────────────────────────────

function patchMatchIteration(
  img: Uint8ClampedArray,
  mask: Uint8Array,
  w: number,
  h: number,
  iteration: number,
  nnf: Int32Array,
  searchRadius: number,
  randomSamples: number
): void {
  // Collect masked pixels, sorted by distance from boundary
  const distance = new Float32Array(w * h);
  distance.fill(Infinity);

  const bfsQueue: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (mask[idx] === 0) continue;

      for (const [dy, dx] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const ny = y + dy, nx = x + dx;
        if (ny >= 0 && ny < h && nx >= 0 && nx < w && mask[ny * w + nx] === 0) {
          distance[idx] = 1;
          bfsQueue.push(idx);
          break;
        }
      }
    }
  }

  let head = 0;
  while (head < bfsQueue.length) {
    const idx = bfsQueue[head++];
    const x = idx % w;
    const y = (idx - x) / w;

    for (const [dy, dx] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const ny = y + dy, nx = x + dx;
      if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
      const nIdx = ny * w + nx;
      if (mask[nIdx] === 0) continue;

      const newDist = distance[idx] + 1;
      if (newDist < distance[nIdx]) {
        distance[nIdx] = newDist;
        bfsQueue.push(nIdx);
      }
    }
  }

  // Sort masked pixels by distance (boundary first)
  const maskedPixels: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (mask[i] === 1) maskedPixels.push(i);
  }
  maskedPixels.sort((a, b) => distance[a] - distance[b]);

  // Create RNG for this iteration (different seed per iteration for diversity)
  const rng = createRNG(iteration * 7919 + 42);

  // Process each masked pixel: find best patch and copy center pixel
  for (const idx of maskedPixels) {
    const tx = idx % w;
    const ty = (idx - tx) / w;

    const best = findBestPatch(img, mask, tx, ty, w, h, nnf, searchRadius, randomSamples, rng);

    // Copy the center pixel from the best matching patch
    const srcIdx = best.y * w + best.x;

    // On later iterations, blend with previous result for smoother transitions
    if (iteration > 0 && best.dist > 200) {
      // Bad match — blend 50/50 with previous to avoid harsh jumps
      img[idx * 4] = Math.round((img[idx * 4] + img[srcIdx * 4]) / 2);
      img[idx * 4 + 1] = Math.round((img[idx * 4 + 1] + img[srcIdx * 4 + 1]) / 2);
      img[idx * 4 + 2] = Math.round((img[idx * 4 + 2] + img[srcIdx * 4 + 2]) / 2);
    } else {
      img[idx * 4] = img[srcIdx * 4];
      img[idx * 4 + 1] = img[srcIdx * 4 + 1];
      img[idx * 4 + 2] = img[srcIdx * 4 + 2];
    }
    img[idx * 4 + 3] = 255;

    // Store in NNF for propagation to subsequent pixels
    nnf[idx] = best.y * w + best.x;
  }
}

// ──────────────────────────────────────────────
//  Boundary blending for seamless transitions
//  Only affects pixels very close to the mask edge.
// ──────────────────────────────────────────────

function blendBoundary(
  img: Uint8ClampedArray,
  mask: Uint8Array,
  w: number,
  h: number,
  radius: number
): void {
  // Compute distance from each masked pixel to nearest non-masked pixel
  const dist = new Float32Array(w * h);
  dist.fill(Infinity);

  const queue: number[] = [];

  for (let i = 0; i < w * h; i++) {
    if (mask[i] === 0) {
      dist[i] = 0;
      queue.push(i);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++];
    const x = idx % w;
    const y = (idx - x) / w;

    for (const [dy, dx] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const ny = y + dy, nx = x + dx;
      if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
      const nIdx = ny * w + nx;
      const newDist = dist[idx] + 1;
      if (newDist < dist[nIdx]) {
        dist[nIdx] = newDist;
        queue.push(nIdx);
      }
    }
  }

  // Light blend near boundary — only the first 2-3 pixels
  const temp = new Uint8ClampedArray(img);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (mask[idx] === 0) continue;
      if (dist[idx] > 3) continue; // Only the closest 3 pixels to boundary

      // Strong blend right at boundary, fading quickly
      const blendWeight = Math.exp(-dist[idx] * 1.2);

      // Weighted average with non-masked neighbors
      let sumR = 0, sumG = 0, sumB = 0, totalWeight = 0;

      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
          const nIdx = ny * w + nx;
          if (mask[nIdx] !== 0) continue; // Only non-masked neighbors

          const d = Math.abs(dx) + Math.abs(dy);
          const w1 = Math.exp(-d * 0.5);

          sumR += temp[nIdx * 4] * w1;
          sumG += temp[nIdx * 4 + 1] * w1;
          sumB += temp[nIdx * 4 + 2] * w1;
          totalWeight += w1;
        }
      }

      if (totalWeight > 0) {
        const avgR = sumR / totalWeight;
        const avgG = sumG / totalWeight;
        const avgB = sumB / totalWeight;

        img[idx * 4] = Math.round(img[idx * 4] * (1 - blendWeight) + avgR * blendWeight);
        img[idx * 4 + 1] = Math.round(img[idx * 4 + 1] * (1 - blendWeight) + avgG * blendWeight);
        img[idx * 4 + 2] = Math.round(img[idx * 4 + 2] * (1 - blendWeight) + avgB * blendWeight);
      }
    }
  }
}

// ──────────────────────────────────────────────
//  Utility functions (same interface as old inpaint.ts)
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
