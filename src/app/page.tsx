"use client";

import { useState, useRef, useCallback } from "react";
import Canvas, { type CanvasHandle } from "@/components/eraser/Canvas";
import Toolbar, { type Tool } from "@/components/eraser/Toolbar";
import UploadZone from "@/components/eraser/UploadZone";
import GoldVignette from "@/components/eraser/GoldVignette";
import { inpaintDiffusion, compositeResult } from "@/lib/inpaint";
import { useToast } from "@/hooks/use-toast";
import { Sparkles } from "lucide-react";

const MAX_DIMENSION = 1400;

interface ImageState {
  dataUrl: string;
  width: number;
  height: number;
  /** Original dimensions before downscaling (for display info) */
  originalWidth: number;
  originalHeight: number;
}

/** Downscale image if it exceeds MAX_DIMENSION on longest side */
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

  const handleErase = useCallback(async () => {
    if (!canvasRef.current || !image) return;
    setIsProcessing(true);
    setHasResult(false);

    try {
      const imgDataUrl = canvasRef.current.getImageDataUrl();
      const maskDataUrl = canvasRef.current.getMaskDataUrl();
      const { width, height } = canvasRef.current.getImageDimensions();

      if (!imgDataUrl || !maskDataUrl) {
        toast({
          title: "Nothing to erase",
          description: "Paint over the object you want to remove first.",
          variant: "destructive",
        });
        setIsProcessing(false);
        return;
      }

      // Client-side diffusion inpainting (works offline, no server needed)
      const resultDataUrl = await clientSideInpaint(imgDataUrl, maskDataUrl, width, height);

      if (resultDataUrl) {
        canvasRef.current.setResultImage(resultDataUrl);
        setHasResult(true);
        toast({
          title: "Object erased!",
          description: "The selected object has been removed. Download or continue editing.",
        });
      }
    } catch (error) {
      console.error("Erase error:", error);
      toast({
        title: "Error",
        description: "Something went wrong while erasing. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsProcessing(false);
    }
  }, [image, toast]);

  const handleDownload = useCallback(() => {
    if (!canvasRef.current) return;

    // Use the imperative handle methods for reliable download
    let resultDataUrl: string;

    if (hasResult) {
      // Get the result canvas data through the handle
      resultDataUrl = canvasRef.current.getResultDataUrl();
    } else {
      resultDataUrl = canvasRef.current.getImageDataUrl();
    }

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
  }, [toast, hasResult]);

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
    // Dismiss result overlay — undo means user wants to edit mask again
    setHasResult(false);
    // State will be updated via onHistoryChange callback from Canvas
  }, []);

  const handleRedo = useCallback(() => {
    canvasRef.current?.redo();
    // Dismiss result overlay — redo means user wants to edit mask again
    setHasResult(false);
    // State will be updated via onHistoryChange callback from Canvas
  }, []);

  const handleClearMask = useCallback(() => {
    canvasRef.current?.clearMask();
    setHasMask(false);
    setHasResult(false);
  }, []);

  // Zoom controls — passed to Canvas via props
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
          AI-powered object removal
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
              <div className="absolute inset-0 z-30 bg-sapphire-dark/70 backdrop-blur-sm flex flex-col items-center justify-center gap-4">
                <div className="relative">
                  <div className="w-16 h-16 rounded-full border-2 border-gold/30 animate-spin" style={{ animationDuration: "1.5s" }}>
                    <div className="absolute top-0 left-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-gold" />
                  </div>
                  <Sparkles className="absolute inset-0 m-auto w-6 h-6 text-gold animate-pulse" />
                </div>
                <div className="text-center">
                  <p className="text-foreground font-medium">Erasing object...</p>
                  <p className="text-muted-foreground text-sm mt-1">AI is filling in the area</p>
                </div>
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

// Helper: Client-side diffusion inpainting
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
        const maskData = mCtx.getImageData(0, 0, width, height);

        // Run diffusion inpainting
        const result = inpaintDiffusion(
          {
            width,
            height,
            data: new Uint8ClampedArray(origData.data),
          },
          {
            width,
            height,
            data: maskData.data,
          },
          150
        );

        // Composite
        const composited = compositeResult(
          { width, height, data: origData.data },
          result,
          { width, height, data: maskData.data }
        );

        // Put on canvas
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
