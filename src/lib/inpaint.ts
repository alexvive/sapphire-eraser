/**
 * Client-side inpainting algorithm for SapphireEraser.
 *
 * v6 — Clean BFS Fill + Boundary Extension + Gentle Smoothing
 *
 * Philosophy: Simplicity over complexity. The v5 exemplar-based approach
 * was too clever and produced muddy results on many images. This version
 * returns to the proven BFS approach with targeted improvements:
 *
 * 1. BFS fill from boundary inward with COLOR CLUSTERING — prevents
 *    different texture colors from blending into muddy averages
 * 2. Boundary texture extension — copies actual pixel colors from
 *    the nearest boundary source to preserve patterns
 * 3. Light refinement pass with clustered blending
 * 4. Feathered boundary blending — seamless edge transitions
 *
 * No exemplar matching, no gradient-aware smoothing, no texture noise.
 * Clean and predictable.
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

  // 4. Light refinement pass with clustered blending
  refinementPassClustered(result, maskArr, w, h, 45);

  // 5. Boundary feathering (wide radius for seamless blend)
  blendBoundary(result, maskArr, w, h, 5);

  return { width: w, height: h, data: result };
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

    // Adaptive threshold: check local color variance
    let sumR = 0, sumG = 0, sumB = 0;
    const sampleColors: [number, number, number][] = [];
    for (const s of colorSamples) {
      sumR += s.r; sumG += s.g; sumB += s.b;
      sampleColors.push([s.r, s.g, s.b]);
    }
    const count = sampleColors.length;
    let threshold = 50;
    if (count >= 4) {
      const avgR = sumR / count, avgG = sumG / count, avgB = sumB / count;
      let variance = 0;
      for (const [r, g, b] of sampleColors) {
        variance += (r - avgR) ** 2 + (g - avgG) ** 2 + (b - avgB) ** 2;
      }
      variance /= count;
      const std = Math.sqrt(variance);
      // More variance → wider threshold (accept more diverse colors)
      // Less variance → tighter threshold (keep it uniform)
      threshold = Math.max(25, Math.min(65, 75 - std * 0.3));
    }

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

    // Look in the OPPOSITE direction from source for texture extension
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
      // Gentle blend — don't override the BFS result too aggressively
      const blendFactor = Math.min(0.5, 0.15 + dist * 0.025);

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
