/**
 * Client-side inpainting algorithm for SapphireEraser.
 *
 * v5 — Exemplar-Based Texture Copy + Enhanced Patch Matching
 *
 * Key improvement over v4: On complex/patterned backgrounds, instead of
 * averaging boundary colors (which produces muddy brown), we now COPY
 * actual texture patches from the best-matching source region. This
 * preserves patterns like polka dots, stripes, fabric weave, etc.
 *
 * Pipeline:
 *   1. Exemplar-based patch copy — for each masked pixel, find the best
 *      matching source patch and copy it wholesale (preserves texture patterns)
 *   2. BFS fill from boundary inward with adaptive color clustering (fallback)
 *   3. Boundary texture extension — mirrors boundary textures inward
 *   4. Multi-pass refinement with adaptive clustered blending
 *   5. Gradient-aware smoothing — preserves edges
 *   6. Adaptive texture noise — matches local texture grain
 *   7. Feathered boundary blending — seamless edge transitions
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

  // 2. Exemplar-based fill — COPY actual texture patches from source region
  //    This is the key improvement: instead of averaging colors (which produces
  //    muddy results on patterned backgrounds), we copy whole texture patches.
  exemplarBasedFill(result, maskArr, w, h);

  // 3. BFS fill remaining unfilled pixels with adaptive color clustering
  bfsFillClustered(result, maskArr, w, h);

  // 4. Boundary texture extension — copy colors from nearest source
  boundaryTextureExtension(result, maskArr, w, h);

  // 5. First refinement pass with clustered blending
  refinementPassClustered(result, maskArr, w, h, 50);

  // 6. Gradient-aware smoothing pass
  gradientAwareSmooth(result, maskArr, w, h);

  // 7. Second refinement pass (tighter clustering for final polish)
  refinementPassClustered(result, maskArr, w, h, 35);

  // 8. Add texture noise (adaptive to local variance)
  addTextureNoise(result, maskArr, w, h, 2.5);

  // 9. Boundary feathering (wider radius for seamless blend)
  blendBoundary(result, maskArr, w, h, 6);

  return { width: w, height: h, data: result };
}

// ──────────────────────────────────────────────
//  Exemplar-Based Fill (NEW — the key improvement)
//
//  For each masked pixel, search outward in ALL directions for the best-
//  matching source patch (outside the mask), then COPY that entire patch
//  into the masked region. This preserves actual texture patterns instead
//  of averaging them into muddy colors.
//
//  Priority: process pixels closest to the boundary first (like peeling
//  an onion), so boundary pixels get the most accurate source patches.
// ──────────────────────────────────────────────

function exemplarBasedFill(
  img: Uint8ClampedArray,
  mask: Uint8Array,
  w: number,
  h: number
): void {
  const PATCH_R = 3; // 7x7 patch for matching
  const SEARCH_RADIUS = 30; // how far to search for source patches
  const NUM_DIRECTIONS = 16; // search in 16 directions for best match

  // Build distance-to-boundary map
  const distToBoundary = new Float32Array(w * h);
  distToBoundary.fill(Infinity);
  const queue: number[] = [];
  const visited = new Uint8Array(w * h);

  // BFS from boundary inward
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (mask[idx] === 0) {
        distToBoundary[idx] = 0;
        for (const [dy, dx] of [[-1,0],[1,0],[0,-1],[0,1]] as const) {
          const ny = y + dy, nx = x + dx;
          if (ny >= 0 && ny < h && nx >= 0 && nx < w) {
            const nIdx = ny * w + nx;
            if (mask[nIdx] === 1 && !visited[nIdx]) {
              distToBoundary[nIdx] = 1;
              visited[nIdx] = 1;
              queue.push(nIdx);
            }
          }
        }
      }
    }
  }

  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++];
    const x = idx % w;
    const y = (idx - x) / w;
    for (const [dy, dx] of [[-1,0],[1,0],[0,-1],[0,1]] as const) {
      const ny = y + dy, nx = x + dx;
      if (ny >= 0 && ny < h && nx >= 0 && nx < w) {
        const nIdx = ny * w + nx;
        if (mask[nIdx] === 1 && !visited[nIdx]) {
          distToBoundary[nIdx] = distToBoundary[idx] + 1;
          visited[nIdx] = 1;
          queue.push(nIdx);
        }
      }
    }
  }

  // Collect masked pixels sorted by distance to boundary (closest first)
  const maskedPixels: { idx: number; x: number; y: number; dist: number }[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (mask[idx] === 1 && distToBoundary[idx] < Infinity) {
        maskedPixels.push({ idx, x, y, dist: distToBoundary[idx] });
      }
    }
  }
  maskedPixels.sort((a, b) => a.dist - b.dist);

  // For each masked pixel, find the best source patch and copy it
  // We track which pixels have been "exemplar-filled" so later pixels
  // can use them as boundary context
  const isExemplarFilled = new Uint8Array(w * h);
  const exemplarColors = new Uint8ClampedArray(w * h * 3);

  // Seed: all non-masked pixels are "exemplar-filled"
  for (let i = 0; i < w * h; i++) {
    if (mask[i] === 0) {
      isExemplarFilled[i] = 1;
      exemplarColors[i * 3] = img[i * 4];
      exemplarColors[i * 3 + 1] = img[i * 4 + 1];
      exemplarColors[i * 3 + 2] = img[i * 4 + 2];
    }
  }

  // Helper: get color from exemplar (original or already-filled)
  const getColor = (px: number, py: number): [number, number, number] | null => {
    if (px < 0 || px >= w || py < 0 || py >= h) return null;
    const pIdx = py * w + px;
    if (!isExemplarFilled[pIdx]) return null;
    return [exemplarColors[pIdx * 3], exemplarColors[pIdx * 3 + 1], exemplarColors[pIdx * 3 + 2]];
  };

  for (const { idx, x, y, dist } of maskedPixels) {
    // Build "known" context around this pixel (partially filled boundary)
    const knownColors: { dx: number; dy: number; r: number; g: number; b: number }[] = [];
    for (let dy = -PATCH_R; dy <= PATCH_R; dy++) {
      for (let dx = -PATCH_R; dx <= PATCH_R; dx++) {
        if (dx === 0 && dy === 0) continue;
        const ny = y + dy, nx = x + dx;
        const c = getColor(nx, ny);
        if (c) {
          knownColors.push({ dx, dy, r: c[0], g: c[1], b: c[2] });
        }
      }
    }

    let bestMatch = Infinity;
    let bestSrcX = -1;
    let bestSrcY = -1;

    if (knownColors.length >= 3) {
      // Search in multiple directions for the best matching source
      for (let angle = 0; angle < NUM_DIRECTIONS; angle++) {
        const ang = (angle / NUM_DIRECTIONS) * Math.PI * 2;
        const dirX = Math.cos(ang);
        const dirY = Math.sin(ang);

        for (let d = 2; d <= SEARCH_RADIUS; d++) {
          const sx = Math.round(x + dirX * d);
          const sy = Math.round(y + dirY * d);

          if (sx < PATCH_R || sx >= w - PATCH_R || sy < PATCH_R || sy >= h - PATCH_R) continue;
          if (mask[sy * w + sx] !== 0) continue;

          // Compare known context with source context
          let matchScore = 0;
          let matchCount = 0;

          for (const kc of knownColors) {
            const srcPx = sx + kc.dx;
            const srcPy = sy + kc.dy;
            if (srcPx < 0 || srcPx >= w || srcPy < 0 || srcPy >= h) continue;
            const srcIdx = srcPy * w + srcPx;
            if (mask[srcIdx] !== 0) continue;

            const dr = kc.r - img[srcIdx * 4];
            const dg = kc.g - img[srcIdx * 4 + 1];
            const db = kc.b - img[srcIdx * 4 + 2];
            matchScore += dr * dr + dg * dg + db * db;
            matchCount++;
          }

          if (matchCount >= 3) {
            const normalizedScore = matchScore / matchCount;
            if (normalizedScore < bestMatch) {
              bestMatch = normalizedScore;
              bestSrcX = sx;
              bestSrcY = sy;
            }
          }
        }
      }
    }

    if (bestSrcX >= 0 && bestSrcY >= 0) {
      // Copy the entire patch from source to destination
      for (let dy = -PATCH_R; dy <= PATCH_R; dy++) {
        for (let dx = -PATCH_R; dx <= PATCH_R; dx++) {
          const dstX = x + dx;
          const dstY = y + dy;
          const srcX = bestSrcX + dx;
          const srcY = bestSrcY + dy;

          if (dstX < 0 || dstX >= w || dstY < 0 || dstY >= h) continue;
          if (srcX < 0 || srcX >= w || srcY < 0 || srcY >= h) continue;

          const dstIdx = dstY * w + dstX;
          const srcIdx = srcY * w + srcX;

          if (mask[dstIdx] === 1 && !isExemplarFilled[dstIdx] && mask[srcIdx] === 0) {
            // Distance-based blending: pixels closer to center get more weight
            const distFromCenter = Math.sqrt(dx * dx + dy * dy);
            const maxDist = PATCH_R * Math.SQRT2;
            const weight = Math.max(0.3, 1 - distFromCenter / maxDist * 0.5);

            const srcR = img[srcIdx * 4];
            const srcG = img[srcIdx * 4 + 1];
            const srcB = img[srcIdx * 4 + 2];

            exemplarColors[dstIdx * 3] = srcR;
            exemplarColors[dstIdx * 3 + 1] = srcG;
            exemplarColors[dstIdx * 3 + 2] = srcB;
            isExemplarFilled[dstIdx] = 1;

            // Write to img with blending
            img[dstIdx * 4] = Math.round(srcR * weight + img[dstIdx * 4] * (1 - weight));
            img[dstIdx * 4 + 1] = Math.round(srcG * weight + img[dstIdx * 4 + 1] * (1 - weight));
            img[dstIdx * 4 + 2] = Math.round(srcB * weight + img[dstIdx * 4 + 2] * (1 - weight));
            img[dstIdx * 4 + 3] = 255;
          }
        }
      }
    }
  }
}

// ──────────────────────────────────────────────
//  Color clustering helper
// ──────────────────────────────────────────────

interface ColorSample {
  r: number;
  g: number;
  b: number;
  weight: number;
}

function clusterAndAverage(
  colors: ColorSample[],
  threshold: number = 50
): { r: number; g: number; b: number } | null {
  if (colors.length === 0) return null;

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
//  Adaptive clustering threshold
// ──────────────────────────────────────────────

function adaptiveClusterThreshold(
  img: Uint8ClampedArray,
  mask: Uint8Array,
  w: number,
  h: number,
  x: number,
  y: number
): number {
  let sumR = 0, sumG = 0, sumB = 0, count = 0;
  const colors: [number, number, number][] = [];

  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const ny = y + dy, nx = x + dx;
      if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
      const nIdx = ny * w + nx;
      if (mask[nIdx] !== 0) continue;
      const r = img[nIdx * 4];
      const g = img[nIdx * 4 + 1];
      const b = img[nIdx * 4 + 2];
      sumR += r; sumG += g; sumB += b;
      colors.push([r, g, b]);
      count++;
    }
  }

  if (count < 4) return 55;

  const avgR = sumR / count, avgG = sumG / count, avgB = sumB / count;
  let variance = 0;
  for (const [r, g, b] of colors) {
    variance += (r - avgR) ** 2 + (g - avgG) ** 2 + (b - avgB) ** 2;
  }
  variance /= count;
  const std = Math.sqrt(variance);

  return Math.max(25, Math.min(65, 75 - std * 0.3));
}

// ──────────────────────────────────────────────
//  BFS Fill with Adaptive Color Clustering
// ──────────────────────────────────────────────

function bfsFillClustered(
  img: Uint8ClampedArray,
  mask: Uint8Array,
  w: number,
  h: number
): void {
  const filled = new Float32Array(w * h * 3);
  const isFilled = new Uint8Array(w * h);

  for (let i = 0; i < w * h; i++) {
    if (mask[i] === 0) {
      filled[i * 3] = img[i * 4];
      filled[i * 3 + 1] = img[i * 4 + 1];
      filled[i * 3 + 2] = img[i * 4 + 2];
      isFilled[i] = 1;
    }
    // Also consider exemplar-filled pixels as already filled
    if (img[i * 4 + 3] === 255 && mask[i] === 1) {
      filled[i * 3] = img[i * 4];
      filled[i * 3 + 1] = img[i * 4 + 1];
      filled[i * 3 + 2] = img[i * 4 + 2];
      isFilled[i] = 1;
    }
  }

  const queue: number[] = [];
  const inQueue = new Uint8Array(w * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (isFilled[idx]) continue;
      if (mask[idx] === 0) continue;

      let isBoundary = false;
      for (const [dy, dx] of [[-1,0],[1,0],[0,-1],[0,1]] as const) {
        const ny = y + dy, nx = x + dx;
        if (ny >= 0 && ny < h && nx >= 0 && nx < w && isFilled[ny * w + nx]) {
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

  const neighbours: [number, number, number][] = [
    [-1, 0, 1.0], [1, 0, 1.0], [0, -1, 1.0], [0, 1, 1.0],
    [-1, -1, 0.6], [-1, 1, 0.6], [1, -1, 0.6], [1, 1, 0.6]
  ];

  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++];
    const x = idx % w;
    const y = (idx - x) / w;

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

    const threshold = adaptiveClusterThreshold(img, mask, w, h, x, y);
    const result = clusterAndAverage(colorSamples, threshold);

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

    for (const [dy, dx] of [[-1,0],[1,0],[0,-1],[0,1]] as const) {
      const ny = y + dy, nx = x + dx;
      if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
      const nIdx = ny * w + nx;
      if (mask[nIdx] === 1 && !isFilled[nIdx] && !inQueue[nIdx]) {
        queue.push(nIdx);
        inQueue[nIdx] = 1;
      }
    }
  }
}

// ──────────────────────────────────────────────
//  Boundary Texture Extension
// ──────────────────────────────────────────────

function boundaryTextureExtension(
  img: Uint8ClampedArray,
  mask: Uint8Array,
  w: number,
  h: number
): void {
  const nearestSrcIdx = new Int32Array(w * h);
  nearestSrcIdx.fill(-1);

  const found = new Uint8Array(w * h);
  const queue: number[] = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (mask[idx] === 0) {
        nearestSrcIdx[idx] = idx;
        found[idx] = 1;

        for (const [dy, dx] of [[-1,0],[1,0],[0,-1],[0,1]] as const) {
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

  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++];
    const x = idx % w;
    const y = (idx - x) / w;

    let bestDist = Infinity;
    let bestSrc = -1;

    for (const [dy, dx] of [[-1,0],[1,0],[0,-1],[0,1]] as const) {
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

    for (const [dy, dx] of [[-1,0],[1,0],[0,-1],[0,1]] as const) {
      const ny = y + dy, nx = x + dx;
      if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
      const nIdx = ny * w + nx;
      if (mask[nIdx] === 1 && !found[nIdx]) {
        queue.push(nIdx);
        found[nIdx] = 1;
      }
    }
  }

  const bfsResult = new Uint8ClampedArray(img);

  for (let i = 0; i < w * h; i++) {
    if (mask[i] === 0 || nearestSrcIdx[i] < 0) continue;

    const x = i % w;
    const y = (i - x) / w;
    const srcIdx = nearestSrcIdx[i];
    const srcX = srcIdx % w;
    const srcY = (srcIdx - srcX) / w;

    const dx = x - srcX;
    const dy = y - srcY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 0.5) continue;

    const ndx = dx / dist;
    const ndy = dy / dist;

    let bestColor: number[] | null = null;

    for (const offset of [0, 1, 2, 3, 5, 8, 12]) {
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
      const blendFactor = Math.min(0.7, 0.25 + dist * 0.04);

      img[i * 4] = Math.round(bfsResult[i * 4] * (1 - blendFactor) + bestColor[0] * blendFactor);
      img[i * 4 + 1] = Math.round(bfsResult[i * 4 + 1] * (1 - blendFactor) + bestColor[1] * blendFactor);
      img[i * 4 + 2] = Math.round(bfsResult[i * 4 + 2] * (1 - blendFactor) + bestColor[2] * blendFactor);
    }
  }
}

// ──────────────────────────────────────────────
//  Refinement pass with color clustering
// ──────────────────────────────────────────────

function refinementPassClustered(
  img: Uint8ClampedArray,
  mask: Uint8Array,
  w: number,
  h: number,
  clusterThreshold: number = 50
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

      const result = clusterAndAverage(colorSamples, clusterThreshold);

      if (result) {
        img[idx * 4] = Math.round(result.r);
        img[idx * 4 + 1] = Math.round(result.g);
        img[idx * 4 + 2] = Math.round(result.b);
      }
    }
  }
}

// ──────────────────────────────────────────────
//  Gradient-Aware Smoothing
// ──────────────────────────────────────────────

function gradientAwareSmooth(
  img: Uint8ClampedArray,
  mask: Uint8Array,
  w: number,
  h: number
): void {
  const temp = new Uint8ClampedArray(img);

  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const idx = y * w + x;
      if (mask[idx] === 0) continue;

      const getGray = (px: number, py: number): number => {
        if (px < 0 || px >= w || py < 0 || py >= h) return 0;
        const i = py * w + px;
        return temp[i * 4] * 0.299 + temp[i * 4 + 1] * 0.587 + temp[i * 4 + 2] * 0.114;
      };

      const gx =
        -getGray(x - 1, y - 1) + getGray(x + 1, y - 1)
        - 2 * getGray(x - 1, y) + 2 * getGray(x + 1, y)
        - getGray(x - 1, y + 1) + getGray(x + 1, y + 1);

      const gy =
        -getGray(x - 1, y - 1) - 2 * getGray(x, y - 1) - getGray(x + 1, y - 1)
        + getGray(x - 1, y + 1) + 2 * getGray(x, y + 1) + getGray(x + 1, y + 1);

      const gradMag = Math.sqrt(gx * gx + gy * gy);

      let smoothR = 0, smoothG = 0, smoothB = 0, totalWeight = 0;

      if (gradMag < 15) {
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const ny = y + dy, nx = x + dx;
            if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
            const nIdx = ny * w + nx;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const weight = Math.exp(-dist * 0.5);
            const isOriginal = mask[nIdx] === 0;
            const w2 = weight * (isOriginal ? 2.5 : 1.0);
            smoothR += temp[nIdx * 4] * w2;
            smoothG += temp[nIdx * 4 + 1] * w2;
            smoothB += temp[nIdx * 4 + 2] * w2;
            totalWeight += w2;
          }
        }
      } else {
        const tangentX = -gy / gradMag;
        const tangentY = gx / gradMag;

        for (let d = -3; d <= 3; d++) {
          const nx = Math.round(x + tangentX * d);
          const ny = Math.round(y + tangentY * d);
          if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
          const nIdx = ny * w + nx;

          const weight = Math.exp(-Math.abs(d) * 0.4);
          const isOriginal = mask[nIdx] === 0;
          const w2 = weight * (isOriginal ? 2.5 : 1.0);
          smoothR += temp[nIdx * 4] * w2;
          smoothG += temp[nIdx * 4 + 1] * w2;
          smoothB += temp[nIdx * 4 + 2] * w2;
          totalWeight += w2;
        }

        smoothR += temp[idx * 4] * 2.0;
        smoothG += temp[idx * 4 + 1] * 2.0;
        smoothB += temp[idx * 4 + 2] * 2.0;
        totalWeight += 2.0;
      }

      if (totalWeight > 0) {
        img[idx * 4] = Math.round(smoothR / totalWeight);
        img[idx * 4 + 1] = Math.round(smoothG / totalWeight);
        img[idx * 4 + 2] = Math.round(smoothB / totalWeight);
      }
    }
  }
}

// ──────────────────────────────────────────────
//  Texture noise (adaptive)
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

      const noiseScale = Math.max(0.3, Math.min(localStd * 0.4, strength * 1.5));

      img[idx * 4] = Math.max(0, Math.min(255, Math.round(img[idx * 4] + rand() * noiseScale)));
      img[idx * 4 + 1] = Math.max(0, Math.min(255, Math.round(img[idx * 4 + 1] + rand() * noiseScale)));
      img[idx * 4 + 2] = Math.max(0, Math.min(255, Math.round(img[idx * 4 + 2] + rand() * noiseScale)));
    }
  }
}

// ──────────────────────────────────────────────
//  Boundary blending (feathered)
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
            ? 3.5 * Math.exp(-dist * 0.3)
            : Math.exp(-dist * 0.3);

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
//  Utility functions
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
