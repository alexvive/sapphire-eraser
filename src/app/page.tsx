"use client";

import { useState, useRef, useCallback } from "react";
import Canvas, { type CanvasHandle } from "@/components/eraser/Canvas";
import Toolbar, { type Tool } from "@/components/eraser/Toolbar";
import UploadZone from "@/components/eraser/UploadZone";
import GoldVignette from "@/components/eraser/GoldVignette";
import { patchMatchInpaint, compositeResult } from "@/lib/inpaint-patchmatch";
import { useToast } from "@/hooks/use-toast";
import { Sparkles } from "lucide-react";

const MAX_DIMENSION = 1400;

interface ImageState {
  dataUrl: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
}

function fitToMaxSize(
  dataUrl: string,
  naturalWidth: number,
  naturalHeight: number
): Promise<{ dataUrl: string; width: number; height: number }> {
  return new Promise((resolve) => {
    const maxDim = Math.max(naturalWidth, naturalHeight);
    if (maxDim <= MAX_DIMENSION) {
      resolve({ dataUrl, width: naturalWidth, height: naturalHeight });
      return;
    }
    const scale = MAX_DIMENSION / maxDim;
    const newW = Math.round(naturalWidth * scale);
    const newH = Math.round(naturalHeight * scale);

    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = newW;
      canvas.height = newH;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, newW, newH);
      resolve({ dataUrl: canvas.toDataURL("image/png"), width: newW, height: newH });
    };
    img.src = dataUrl;
  });
}

export default function Home() {
  const [image, setImage] = useState<ImageState | null>(null);
  const [imageKey, setImageKey] = useState(0);
  const [tool, setTool] = useState<Tool>("brush");
  const [brushSize, setBrushSize] = useState(25);
  const [zoom, setZoom] = useState(1);
  const [hasMask, setHasMask] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [hasResult, setHasResult] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const canvasRef = useRef<CanvasHandle>(null);
  const { toast } = useToast();

  const handleImageLoad = useCallback(
    async (dataUrl: string, width: number, height: number) => {
      const fitted = await fitToMaxSize(dataUrl, width, height);
      setImage({
        dataUrl: fitted.dataUrl,
        width: fitted.width,
        height: fitted.height,
        originalWidth: width,
        originalHeight: height,
      });
      setImageKey((k) => k + 1);
      setHasMask(false);
      setHasResult(false);
      setZoom(1);
    },
    []
  );

  const handleMaskChange = useCallback((hasMaskValue: boolean) => {
    setHasMask(hasMaskValue);
  }, []);

  // ─── Manual Erase with step-by-step baking ───
  // 1. Paint mask over object → click Erase
  // 2. Result is shown briefly, then baked into imageCanvas
  // 3. If ghost remains → paint over ghost → click Erase again
  // 4. Each pass removes more until object is fully gone
  const handleErase = useCallback(async () => {
    if (!canvasRef.current || !image) return;
    if (isProcessing) return;

    if (!hasMask) {
      toast({
        title: "Nothing to erase",
        description: "Paint over the object you want to remove first.",
        variant: "destructive",
      });
      return;
    }

    setIsProcessing(true);

    try {
      const imgDataUrl = canvasRef.current.getImageDataUrl();
      const maskDataUrl = canvasRef.current.getMaskDataUrl();
      const { width, height } = canvasRef.current.getImageDimensions();

      if (!imgDataUrl || !maskDataUrl) {
        setIsProcessing(false);
        return;
      }

      // Run BFS inpainting
      const resultDataUrl = await clientSideInpaint(imgDataUrl, maskDataUrl, width, height);

      if (resultDataUrl && canvasRef.current) {
        // Show result on result canvas
        await canvasRef.current.setResultImage(resultDataUrl);

        // Brief pause so user can see the result, then bake into imageCanvas
        await new Promise(r => setTimeout(r, 300));

        // Bake: commit result into imageCanvas, clear mask, save history
        canvasRef.current.bakeResultToImage();
        setHasResult(true);
      }
    } catch (error) {
      console.error("Erase error:", error);
      toast({
        title: "Error",
        description: "Something went wrong during erasing.",
        variant: "destructive",
      });
    } finally {
      setIsProcessing(false);
    }
  }, [image, isProcessing, hasMask, toast]);

  const handleDownload = useCallback(() => {
    if (!canvasRef.current) return;

    const resultDataUrl = canvasRef.current.getImageDataUrl();

    if (!resultDataUrl) {
      toast({
        title: "Nothing to download",
        description: "No image available to save.",
        variant: "destructive",
      });
      return;
    }

    const link = document.createElement("a");
    link.download = `sapphire_erased_${Date.now()}.png`;
    link.href = resultDataUrl;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    toast({
      title: "Downloaded!",
      description: "Your erased image has been saved.",
    });
  }, [toast]);

  const handleNewImage = useCallback(() => {
    setImage(null);
    setImageKey(0);
    setHasMask(false);
    setHasResult(false);
    setZoom(1);
    setTool("brush");
  }, []);

  const handleUndo = useCallback(() => {
    canvasRef.current?.undo();
    setHasResult(false);
  }, []);

  const handleRedo = useCallback(() => {
    canvasRef.current?.redo();
    setHasResult(false);
  }, []);

  const handleClearMask = useCallback(() => {
    canvasRef.current?.clearMask();
    setHasMask(false);
  }, []);

  const handleZoomIn = useCallback(() => setZoom((z) => Math.min(z * 1.25, 4)), []);
  const handleZoomOut = useCallback(() => setZoom((z) => Math.max(z * 0.8, 0.25)), []);
  const handleZoomReset = useCallback(() => setZoom(1), []);

  const handleCanvasZoomChange = useCallback((newZoom: number) => {
    setZoom(newZoom);
  }, []);

  const handleHistoryChange = useCallback((undo: boolean, redo: boolean) => {
    setCanUndo(undo);
    setCanRedo(redo);
  }, []);

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-sapphire-dark">
      <GoldVignette />

      {/* Header */}
      <header className="relative z-10 flex items-center justify-between px-5 py-3 bg-sapphire/80 backdrop-blur-sm border-b border-sapphire-lighter">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gold/15 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-gold" />
          </div>
          <h1 className="text-lg font-semibold tracking-tight">
            <span className="text-gold">Sapphire</span>
            <span className="text-foreground">Eraser</span>
          </h1>
        </div>
        <p className="text-xs text-muted-foreground hidden sm:block">
          Paint over object, then click Erase
        </p>
      </header>

      {/* Main content */}
      <main className="flex-1 relative flex flex-col">
        {!image ? (
          <UploadZone onImageLoad={handleImageLoad} />
        ) : (
          <>
            <Canvas
              key={imageKey}
              ref={canvasRef}
              imageDataUrl={image.dataUrl}
              imageWidth={image.width}
              imageHeight={image.height}
              tool={tool}
              brushSize={brushSize}
              zoom={zoom}
              onMaskChange={handleMaskChange}
              onZoomChange={handleCanvasZoomChange}
              onHistoryChange={handleHistoryChange}
            />

            <Toolbar
              tool={tool}
              brushSize={brushSize}
              zoom={zoom}
              canUndo={canUndo}
              canRedo={canRedo}
              hasMask={hasMask}
              isProcessing={isProcessing}
              hasResult={hasResult}
              onToolChange={setTool}
              onBrushSizeChange={setBrushSize}
              onUndo={handleUndo}
              onRedo={handleRedo}
              onClearMask={handleClearMask}
              onErase={handleErase}
              onDownload={handleDownload}
              onNewImage={handleNewImage}
              onZoomIn={handleZoomIn}
              onZoomOut={handleZoomOut}
              onZoomReset={handleZoomReset}
            />

            {/* Processing overlay */}
            {isProcessing && (
              <div className="absolute inset-0 z-30 bg-sapphire-dark/50 backdrop-blur-sm flex flex-col items-center justify-center gap-3 pointer-events-none">
                <div className="relative">
                  <div className="w-12 h-12 rounded-full border-2 border-gold/30 animate-spin" style={{ animationDuration: "1.5s" }}>
                    <div className="absolute top-0 left-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-gold" />
                  </div>
                  <Sparkles className="absolute inset-0 m-auto w-5 h-5 text-gold animate-pulse" />
                </div>
                <p className="text-foreground text-sm font-medium">Erasing...</p>
              </div>
            )}
          </>
        )}
      </main>

      {/* Footer */}
      <footer className="relative z-10 flex items-center justify-center px-5 py-2 bg-sapphire/60 border-t border-sapphire-lighter/50">
        <p className="text-[10px] text-muted-foreground/50">
          All processing happens securely &bull; Images never stored on server
        </p>
      </footer>
    </div>
  );
}

// ──────────────────────────────────────────────
//  Client-side inpainting with mask dilation
// ──────────────────────────────────────────────

async function clientSideInpaint(
  imgDataUrl: string,
  maskDataUrl: string,
  width: number,
  height: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const origImg = new Image();
    origImg.onerror = () => reject(new Error("Failed to load original image for inpainting"));
    origImg.onload = () => {
      const origCanvas = document.createElement("canvas");
      origCanvas.width = width;
      origCanvas.height = height;
      const oCtx = origCanvas.getContext("2d")!;
      oCtx.drawImage(origImg, 0, 0, width, height);
      const origData = oCtx.getImageData(0, 0, width, height);

      const maskImg = new Image();
      maskImg.onerror = () => reject(new Error("Failed to load mask image for inpainting"));
      maskImg.onload = () => {
        const maskCanvas = document.createElement("canvas");
        maskCanvas.width = width;
        maskCanvas.height = height;
        const mCtx = maskCanvas.getContext("2d")!;
        mCtx.drawImage(maskImg, 0, 0, width, height);
        const maskRawData = mCtx.getImageData(0, 0, width, height);

        // Dilate mask by 2px to cover anti-aliased object edges
        const dilatedMaskData = dilateMaskData(maskRawData, width, height, 2);

        // Run PatchMatch inpainting with the dilated mask
        const result = patchMatchInpaint(
          {
            width,
            height,
            data: new Uint8ClampedArray(origData.data),
          },
          {
            width,
            height,
            data: dilatedMaskData,
          }
        );

        // Composite: replace masked pixels with inpainted result
        const composited = compositeResult(
          { width, height, data: origData.data },
          result,
          { width, height, data: dilatedMaskData }
        );

        const resultCanvas = document.createElement("canvas");
        resultCanvas.width = width;
        resultCanvas.height = height;
        const rCtx = resultCanvas.getContext("2d")!;
        const imageData = new ImageData(composited.data, width, height);
        rCtx.putImageData(imageData, 0, 0);

        resolve(resultCanvas.toDataURL("image/png"));
      };
      maskImg.src = maskDataUrl;
    };
    origImg.src = imgDataUrl;
  });
}

// Dilate mask by N pixels
function dilateMaskData(
  maskImgData: ImageData,
  w: number,
  h: number,
  radius: number
): Uint8ClampedArray {
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    mask[i] = maskImgData.data[i * 4] > 128 ? 1 : 0;
  }

  for (let pass = 0; pass < radius; pass++) {
    const prev = new Uint8Array(mask);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (prev[y * w + x] === 1) continue;
        for (const [dy, dx] of [[-1,0],[1,0],[0,-1],[0,1]] as const) {
          if (prev[(y + dy) * w + (x + dx)] === 1) {
            mask[y * w + x] = 1;
            break;
          }
        }
      }
    }
  }

  const result = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = mask[i] ? 255 : 0;
    result[i * 4] = v;
    result[i * 4 + 1] = v;
    result[i * 4 + 2] = v;
    result[i * 4 + 3] = 255;
  }
  return result;
}
