"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  forwardRef,
  useImperativeHandle,
} from "react";
import type { Tool } from "./Toolbar";

// ──────────────────────────────────────────────
//  Ghost Brush — Golden Formula
//  destination-out + globalAlpha 0.07 + soft radial gradient
//  Makes objects semi-transparent ("ghost") with each stroke
// ──────────────────────────────────────────────

function drawGhostDot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  pressure: number = 0
) {
  const prevAlpha = ctx.globalAlpha;
  const prevComposite = ctx.globalCompositeOperation;

  ctx.globalCompositeOperation = "destination-out";
  ctx.globalAlpha = 0.06 + pressure * 0.05; // "living ghost" with pressure

  const gradient = ctx.createRadialGradient(x, y, 0, x, y, size / 2);
  gradient.addColorStop(0, "rgba(0,0,0,1)");
  gradient.addColorStop(0.5, "rgba(0,0,0,0.6)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");

  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, size / 2, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = prevAlpha;
  ctx.globalCompositeOperation = prevComposite;
}

function drawGhostLine(
  ctx: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  size: number,
  pressure: number = 0
) {
  const prevAlpha = ctx.globalAlpha;
  const prevComposite = ctx.globalCompositeOperation;

  ctx.globalCompositeOperation = "destination-out";
  ctx.globalAlpha = 0.06 + pressure * 0.05;

  // Draw a series of dots along the line for smooth ghost effect
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const steps = Math.max(1, Math.ceil(dist / (size * 0.15)));

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const px = from.x + dx * t;
    const py = from.y + dy * t;

    const gradient = ctx.createRadialGradient(px, py, 0, px, py, size / 2);
    gradient.addColorStop(0, "rgba(0,0,0,1)");
    gradient.addColorStop(0.5, "rgba(0,0,0,0.6)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(px, py, size / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.globalAlpha = prevAlpha;
  ctx.globalCompositeOperation = prevComposite;
}

const GHOST_MASK_COLOR = "rgba(147, 112, 219, 0.35)"; // subtle violet indicator for ghost mask

export interface CanvasHandle {
  getImageDataUrl: () => string;
  getMaskDataUrl: () => string;
  getMaskCanvas: () => HTMLCanvasElement | null;
  getResultDataUrl: () => string;
  clearMask: () => void;
  setResultImage: (dataUrl: string) => Promise<void>;
  bakeResultToImage: () => void;
  getImageDimensions: () => { width: number; height: number };
  undo: () => void;
  redo: () => void;
  getCanUndo: () => boolean;
  getCanRedo: () => boolean;
  hasMaskPixels: () => boolean;
}

interface CanvasProps {
  imageDataUrl: string;
  imageWidth: number;
  imageHeight: number;
  tool: Tool;
  brushSize: number;
  zoom: number;
  onMaskChange: (hasMask: boolean) => void;
  onZoomChange: (zoom: number) => void;
  onHistoryChange: (canUndo: boolean, canRedo: boolean) => void;
}

interface HistoryState {
  imageData: ImageData;
}

const MAX_HISTORY = 30;
const MASK_COLOR = "rgba(255, 80, 80, 0.45)";

const Canvas = forwardRef<CanvasHandle, CanvasProps>(
  ({ imageDataUrl, imageWidth, imageHeight, tool, brushSize, zoom: externalZoom, onMaskChange, onZoomChange, onHistoryChange }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const imageCanvasRef = useRef<HTMLCanvasElement>(null);
    const maskCanvasRef = useRef<HTMLCanvasElement>(null);
    const resultCanvasRef = useRef<HTMLCanvasElement>(null);
    const offscreenMaskRef = useRef<HTMLCanvasElement | null>(null);
    const resultDataRef = useRef<string>("");

    const [pan, setPan] = useState({ x: 0, y: 0 });
    const [isPanning, setIsPanning] = useState(false);
    const [isDrawing, setIsDrawing] = useState(false);
    const [lastPos, setLastPos] = useState<{ x: number; y: number } | null>(null);
    const [spaceHeld, setSpaceHeld] = useState(false);
    const [panStart, setPanStart] = useState<{ x: number; y: number; panX: number; panY: number } | null>(null);

    // History now stores FULL IMAGE state (not just mask), so undo reverts the image too
    const historyRef = useRef<HistoryState[]>([]);
    const historyIndexRef = useRef(-1);
    const canUndoRef = useRef(false);
    const canRedoRef = useRef(false);

    const [showResult, setShowResult] = useState(false);

    // Check if mask has any painted pixels
    const checkMaskEmpty = useCallback(() => {
      const offscreen = offscreenMaskRef.current;
      if (!offscreen) return;
      const ctx = offscreen.getContext("2d")!;
      const data = ctx.getImageData(0, 0, offscreen.width, offscreen.height);
      let hasPixels = false;
      for (let i = 3; i < data.data.length; i += 4) {
        if (data.data[i] > 10) {
          hasPixels = true;
          break;
        }
      }
      onMaskChange(hasPixels);
      return hasPixels;
    }, [onMaskChange]);

    // Save FULL image state to history
    const saveHistory = useCallback(() => {
      const imgCanvas = imageCanvasRef.current;
      if (!imgCanvas) return;
      const ctx = imgCanvas.getContext("2d")!;
      const imageData = ctx.getImageData(0, 0, imgCanvas.width, imgCanvas.height);

      const idx = historyIndexRef.current;
      historyRef.current = historyRef.current.slice(0, idx + 1);
      historyRef.current.push({ imageData });
      if (historyRef.current.length > MAX_HISTORY) {
        historyRef.current.shift();
      }
      historyIndexRef.current = historyRef.current.length - 1;

      canUndoRef.current = historyIndexRef.current > 0;
      canRedoRef.current = false;
    }, []);

    // Restore history state (full image)
    const restoreHistory = useCallback((index: number) => {
      const imgCanvas = imageCanvasRef.current;
      const mskCanvas = maskCanvasRef.current;
      const offscreen = offscreenMaskRef.current;
      if (!imgCanvas || !mskCanvas || !offscreen) return;

      const state = historyRef.current[index];
      if (!state) return;

      // Restore image
      const ctx = imgCanvas.getContext("2d")!;
      ctx.putImageData(state.imageData, 0, 0);

      // Clear mask
      const mCtx = mskCanvas.getContext("2d")!;
      mCtx.clearRect(0, 0, mskCanvas.width, mskCanvas.height);
      const oCtx = offscreen.getContext("2d")!;
      oCtx.clearRect(0, 0, offscreen.width, offscreen.height);

      setShowResult(false);
      resultDataRef.current = "";

      historyIndexRef.current = index;
      canUndoRef.current = index > 0;
      canRedoRef.current = index < historyRef.current.length - 1;

      onHistoryChange(canUndoRef.current, canRedoRef.current);
      onMaskChange(false);
    }, [onHistoryChange, onMaskChange]);

    // ====== Initialize canvases ======
    useEffect(() => {
      const imgCanvas = imageCanvasRef.current;
      const mskCanvas = maskCanvasRef.current;
      const resCanvas = resultCanvasRef.current;
      if (!imgCanvas || !mskCanvas || !resCanvas) return;

      [imgCanvas, mskCanvas, resCanvas].forEach((c) => {
        c.width = imageWidth;
        c.height = imageHeight;
      });

      const ctx = imgCanvas.getContext("2d")!;
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, imageWidth, imageHeight);
        // Save initial state to history AFTER image loads
        historyRef.current = [];
        historyIndexRef.current = -1;
        saveHistory();
        onHistoryChange(false, false);
      };
      img.src = imageDataUrl;

      const mCtx = mskCanvas.getContext("2d")!;
      mCtx.clearRect(0, 0, imageWidth, imageHeight);

      const offscreen = document.createElement("canvas");
      offscreen.width = imageWidth;
      offscreen.height = imageHeight;
      offscreenMaskRef.current = offscreen;

      resultDataRef.current = "";
      setShowResult(false);
    }, [imageDataUrl, imageWidth, imageHeight, saveHistory, onHistoryChange]);

    // ====== Canvas coordinate helpers ======
    const getCanvasPos = useCallback(
      (e: React.MouseEvent | React.TouchEvent) => {
        const container = containerRef.current;
        const mskCanvas = maskCanvasRef.current;
        if (!container || !mskCanvas) return null;

        const rect = container.getBoundingClientRect();
        let clientX: number, clientY: number;

        if ("touches" in e) {
          clientX = e.touches[0].clientX;
          clientY = e.touches[0].clientY;
        } else {
          clientX = e.clientX;
          clientY = e.clientY;
        }

        const mx = clientX - rect.left - rect.width / 2;
        const my = clientY - rect.top - rect.height / 2;

        const canvasX = (mx - pan.x) / externalZoom + mskCanvas.width / 2;
        const canvasY = (my - pan.y) / externalZoom + mskCanvas.height / 2;

        return { x: canvasX, y: canvasY };
      },
      [externalZoom, pan]
    );

    // Draw on mask (and optionally imageCanvas for ghost brush)
    const drawOnMask = useCallback(
      (pos: { x: number; y: number }, prevPos: { x: number; y: number } | null) => {
        const offscreen = offscreenMaskRef.current;
        const mskCanvas = maskCanvasRef.current;
        const imgCanvas = imageCanvasRef.current;
        if (!offscreen || !mskCanvas || !imgCanvas) return;

        const oCtx = offscreen.getContext("2d")!;
        const mCtx = mskCanvas.getContext("2d")!;
        const iCtx = imgCanvas.getContext("2d")!;

        const isErasing = tool === "eraser";
        const isGhost = tool === "ghost";
        const size = brushSize;

        // ═══ GHOST BRUSH: Golden Formula ═══
        // Draws directly on imageCanvas with destination-out + low alpha
        // + soft radial gradient → objects become semi-transparent ghosts
        // Also marks the mask so Smart Erase knows the area
        if (isGhost) {
          // Ghost effect on imageCanvas
          if (prevPos) {
            drawGhostLine(iCtx, prevPos, pos, size);
          } else {
            drawGhostDot(iCtx, pos.x, pos.y, size);
          }

          // Mark mask for Smart Erase (violet tint to distinguish from brush mask)
          oCtx.globalCompositeOperation = "source-over";
          mCtx.globalCompositeOperation = "source-over";
          oCtx.fillStyle = "rgba(255,255,255,0.8)";
          oCtx.strokeStyle = "rgba(255,255,255,0.8)";
          mCtx.fillStyle = GHOST_MASK_COLOR;
          mCtx.strokeStyle = GHOST_MASK_COLOR;

          if (prevPos) {
            // Draw line on mask
            oCtx.lineWidth = size;
            oCtx.lineCap = "round";
            oCtx.lineJoin = "round";
            oCtx.beginPath();
            oCtx.moveTo(prevPos.x, prevPos.y);
            oCtx.lineTo(pos.x, pos.y);
            oCtx.stroke();

            mCtx.lineWidth = size;
            mCtx.lineCap = "round";
            mCtx.lineJoin = "round";
            mCtx.beginPath();
            mCtx.moveTo(prevPos.x, prevPos.y);
            mCtx.lineTo(pos.x, pos.y);
            mCtx.stroke();
          } else {
            oCtx.beginPath();
            oCtx.arc(pos.x, pos.y, size / 2, 0, Math.PI * 2);
            oCtx.fill();

            mCtx.beginPath();
            mCtx.arc(pos.x, pos.y, size / 2, 0, Math.PI * 2);
            mCtx.fill();
          }

          return;
        }

        // ═══ NORMAL BRUSH / ERASER ═══
        if (isErasing) {
          oCtx.globalCompositeOperation = "destination-out";
          mCtx.globalCompositeOperation = "destination-out";
        } else {
          oCtx.globalCompositeOperation = "source-over";
          mCtx.globalCompositeOperation = "source-over";
        }

        oCtx.fillStyle = isErasing ? "rgba(0,0,0,1)" : "rgba(255,255,255,0.8)";
        oCtx.strokeStyle = isErasing ? "rgba(0,0,0,1)" : "rgba(255,255,255,0.8)";
        mCtx.fillStyle = MASK_COLOR;
        mCtx.strokeStyle = MASK_COLOR;

        const drawCircle = (ctx: CanvasRenderingContext2D, x: number, y: number) => {
          ctx.beginPath();
          ctx.arc(x, y, size / 2, 0, Math.PI * 2);
          ctx.fill();
        };

        const drawLine = (ctx: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }) => {
          ctx.lineWidth = size;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.beginPath();
          ctx.moveTo(from.x, from.y);
          ctx.lineTo(to.x, to.y);
          ctx.stroke();
        };

        if (prevPos) {
          drawLine(oCtx, prevPos, pos);
          drawLine(mCtx, prevPos, pos);
        } else {
          drawCircle(oCtx, pos.x, pos.y);
          drawCircle(mCtx, pos.x, pos.y);
        }

        oCtx.globalCompositeOperation = "source-over";
        mCtx.globalCompositeOperation = "source-over";
      },
      [tool, brushSize]
    );

    // Mouse handlers
    const handleMouseDown = useCallback(
      (e: React.MouseEvent) => {
        if (spaceHeld || e.button === 1) {
          setIsPanning(true);
          setPanStart({ x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y });
          return;
        }

        if (e.button === 0) {
          // Save history BEFORE drawing (especially for ghost brush which modifies imageCanvas)
          if (tool === "ghost") {
            saveHistory();
          }
          setIsDrawing(true);
          const pos = getCanvasPos(e);
          if (pos) {
            drawOnMask(pos, null);
            setLastPos(pos);
          }
        }
      },
      [spaceHeld, pan, getCanvasPos, drawOnMask, tool, saveHistory]
    );

    const handleMouseMove = useCallback(
      (e: React.MouseEvent) => {
        if (isPanning && panStart) {
          const dx = e.clientX - panStart.x;
          const dy = e.clientY - panStart.y;
          setPan({ x: panStart.panX + dx, y: panStart.panY + dy });
          return;
        }

        if (isDrawing) {
          const pos = getCanvasPos(e);
          if (pos) {
            drawOnMask(pos, lastPos);
            setLastPos(pos);
          }
        }
      },
      [isPanning, isDrawing, panStart, getCanvasPos, drawOnMask, lastPos]
    );

    const handleMouseUp = useCallback(() => {
      if (isDrawing) {
        setIsDrawing(false);
        setLastPos(null);

        // Check if there are mask pixels
        checkMaskEmpty();
        onHistoryChange(canUndoRef.current, canRedoRef.current);
      }
      if (isPanning) {
        setIsPanning(false);
        setPanStart(null);
      }
    }, [isDrawing, isPanning, checkMaskEmpty, onHistoryChange]);

    // Wheel zoom
    const handleWheel = useCallback(
      (e: React.WheelEvent) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        onZoomChange(Math.min(Math.max(externalZoom * delta, 0.25), 4));
      },
      [externalZoom, onZoomChange]
    );

    // Keyboard shortcuts
    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.code === "Space") {
          e.preventDefault();
          setSpaceHeld(true);
        }
        if (e.ctrlKey || e.metaKey) {
          if (e.code === "KeyZ" && !e.shiftKey) {
            e.preventDefault();
            if (canUndoRef.current) {
              restoreHistory(historyIndexRef.current - 1);
            }
          }
          if ((e.code === "KeyZ" && e.shiftKey) || e.code === "KeyY") {
            e.preventDefault();
            if (canRedoRef.current) {
              restoreHistory(historyIndexRef.current + 1);
            }
          }
        }
      };

      const handleKeyUp = (e: KeyboardEvent) => {
        if (e.code === "Space") {
          setSpaceHeld(false);
        }
      };

      window.addEventListener("keydown", handleKeyDown);
      window.addEventListener("keyup", handleKeyUp);
      return () => {
        window.removeEventListener("keydown", handleKeyDown);
        window.removeEventListener("keyup", handleKeyUp);
      };
    }, [restoreHistory]);

    // Expose handle methods
    useImperativeHandle(ref, () => ({
      getImageDataUrl: () => {
        const canvas = imageCanvasRef.current;
        if (!canvas) return "";
        return canvas.toDataURL("image/png");
      },
      getMaskDataUrl: () => {
        const offscreen = offscreenMaskRef.current;
        if (!offscreen) return "";
        const ctx = offscreen.getContext("2d")!;
        const imgData = ctx.getImageData(0, 0, offscreen.width, offscreen.height);
        const binary = new Uint8ClampedArray(imgData.data.length);
        for (let i = 0; i < imgData.data.length; i += 4) {
          const isMasked = imgData.data[i + 3] > 10;
          binary[i] = isMasked ? 255 : 0;
          binary[i + 1] = isMasked ? 255 : 0;
          binary[i + 2] = isMasked ? 255 : 0;
          binary[i + 3] = 255;
        }
        const tempCanvas = document.createElement("canvas");
        tempCanvas.width = offscreen.width;
        tempCanvas.height = offscreen.height;
        const tCtx = tempCanvas.getContext("2d")!;
        tCtx.putImageData(new ImageData(binary, offscreen.width, offscreen.height), 0, 0);
        return tempCanvas.toDataURL("image/png");
      },
      getMaskCanvas: () => offscreenMaskRef.current,
      getResultDataUrl: () => {
        return resultDataRef.current || "";
      },
      clearMask: () => {
        const offscreen = offscreenMaskRef.current;
        const mskCanvas = maskCanvasRef.current;
        if (!offscreen || !mskCanvas) return;
        const oCtx = offscreen.getContext("2d")!;
        oCtx.clearRect(0, 0, offscreen.width, offscreen.height);
        const mCtx = mskCanvas.getContext("2d")!;
        mCtx.clearRect(0, 0, mskCanvas.width, mskCanvas.height);
        setShowResult(false);
        resultDataRef.current = "";
        onMaskChange(false);
      },
      // Load inpainting result onto the result canvas (shown as overlay)
      setResultImage: (dataUrl: string) => {
        return new Promise<void>((resolve) => {
          const resCanvas = resultCanvasRef.current;
          if (!resCanvas) { resolve(); return; }

          const img = new Image();
          img.onload = () => {
            const rCtx = resCanvas.getContext("2d")!;
            rCtx.clearRect(0, 0, resCanvas.width, resCanvas.height);
            rCtx.drawImage(img, 0, 0, resCanvas.width, resCanvas.height);
            setShowResult(true);
            resultDataRef.current = dataUrl;
            resolve();
          };
          img.onerror = () => {
            console.error("Failed to load result image");
            resolve();
          };
          img.src = dataUrl;
        });
      },
      // Bake the result image directly into imageCanvas and clear mask
      // This makes the erasure permanent and prepares for the next stroke
      bakeResultToImage: () => {
        const imgCanvas = imageCanvasRef.current;
        const resCanvas = resultCanvasRef.current;
        const mskCanvas = maskCanvasRef.current;
        const offscreen = offscreenMaskRef.current;
        if (!imgCanvas || !resCanvas || !mskCanvas || !offscreen) return;

        const ctx = imgCanvas.getContext("2d")!;

        // Draw result canvas content onto image canvas
        ctx.drawImage(resCanvas, 0, 0);

        // Clear mask
        const mCtx = mskCanvas.getContext("2d")!;
        mCtx.clearRect(0, 0, mskCanvas.width, mskCanvas.height);
        const oCtx = offscreen.getContext("2d")!;
        oCtx.clearRect(0, 0, offscreen.width, offscreen.height);

        // Hide result overlay
        setShowResult(false);
        resultDataRef.current = "";

        // Save new image state to history
        saveHistory();

        onMaskChange(false);
        onHistoryChange(canUndoRef.current, canRedoRef.current);
      },
      getImageDimensions: () => ({ width: imageWidth, height: imageHeight }),
      undo: () => {
        if (canUndoRef.current) {
          restoreHistory(historyIndexRef.current - 1);
        }
      },
      redo: () => {
        if (canRedoRef.current) {
          restoreHistory(historyIndexRef.current + 1);
        }
      },
      getCanUndo: () => canUndoRef.current,
      getCanRedo: () => canRedoRef.current,
      hasMaskPixels: () => {
        const offscreen = offscreenMaskRef.current;
        if (!offscreen) return false;
        const ctx = offscreen.getContext("2d")!;
        const data = ctx.getImageData(0, 0, offscreen.width, offscreen.height);
        for (let i = 3; i < data.data.length; i += 4) {
          if (data.data[i] > 10) return true;
        }
        return false;
      },
    }));

    const cursorClass = spaceHeld
      ? isPanning
        ? "cursor-panning"
        : "cursor-pan"
      : tool === "ghost"
      ? "cursor-ghost"
      : tool === "brush"
      ? "cursor-brush"
      : "cursor-eraser";

    return (
      <div
        ref={containerRef}
        className={`flex-1 relative overflow-hidden ${cursorClass}`}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* Checkerboard background */}
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `
              linear-gradient(45deg, #0D1B30 25%, transparent 25%),
              linear-gradient(-45deg, #0D1B30 25%, transparent 25%),
              linear-gradient(45deg, transparent 75%, #0D1B30 75%),
              linear-gradient(-45deg, transparent 75%, #0D1B30 75%)
            `,
            backgroundSize: "20px 20px",
            backgroundPosition: "0 0, 0 10px, 10px -10px, -10px 0px",
            backgroundColor: "#0A1628",
          }}
        />

        {/* Canvas container with zoom & pan */}
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${externalZoom})`,
            transformOrigin: "center center",
          }}
        >
          <div className="relative">
            <canvas
              ref={imageCanvasRef}
              className="max-w-none block"
              style={{
                imageRendering: externalZoom > 2 ? "pixelated" : "auto",
                maxWidth: "none",
              }}
            />
            <canvas
              ref={maskCanvasRef}
              className="max-w-none absolute top-0 left-0"
              style={{
                display: showResult ? "none" : "block",
                pointerEvents: "none",
                maxWidth: "none",
              }}
            />
            <canvas
              ref={resultCanvasRef}
              className="max-w-none absolute top-0 left-0"
              style={{
                display: showResult ? "block" : "none",
                pointerEvents: "none",
                maxWidth: "none",
              }}
            />
          </div>
        </div>
      </div>
    );
  }
);

Canvas.displayName = "Canvas";

export default Canvas;
