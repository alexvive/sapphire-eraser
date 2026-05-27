"use client";

import { useCallback, useRef, useState } from "react";
import { Upload, ImagePlus, Loader2 } from "lucide-react";

interface UploadZoneProps {
  onImageLoad: (imageDataUrl: string, width: number, height: number) => void;
}

export default function UploadZone({ onImageLoad }: UploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    (file: File) => {
      if (!file.type.startsWith("image/")) {
        alert("Please select an image file (PNG, JPG, or WebP).");
        return;
      }
      if (file.size > 20 * 1024 * 1024) {
        alert("File too large. Maximum size is 20MB.");
        return;
      }

      setIsLoading(true);
      const reader = new FileReader();

      reader.onerror = () => {
        setIsLoading(false);
        alert("Failed to read the file. Please try again.");
      };

      reader.onload = (e) => {
        const dataUrl = e.target?.result as string;
        if (!dataUrl) {
          setIsLoading(false);
          alert("Failed to read the file. Please try again.");
          return;
        }

        const img = new Image();
        img.onerror = () => {
          setIsLoading(false);
          alert("Failed to load the image. The file might be corrupted.");
        };
        img.onload = () => {
          // Reset loading BEFORE calling onImageLoad (which unmounts this component)
          setIsLoading(false);
          onImageLoad(dataUrl, img.naturalWidth, img.naturalHeight);
        };
        img.src = dataUrl;
      };

      reader.readAsDataURL(file);
    },
    [onImageLoad]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
      // Reset value so the same file can be re-selected
      e.target.value = "";
    },
    [handleFile]
  );

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      {/*
        File input: NOT display:none — use opacity:0 + absolute positioning instead.
        display:none can prevent .click() from opening the file dialog in some browsers
        (iOS Safari, some Firefox configs). This approach keeps the element in the
        layout flow so the browser treats it as a valid activation target.
      */}
      <input
        ref={fileInputRef}
        id="sapphire-file-input"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={handleInputChange}
        className="absolute opacity-0 w-0 h-0 overflow-hidden"
        style={{ position: "absolute" }}
        tabIndex={-1}
      />

      {/*
        Use a <label> with htmlFor pointing to the file input.
        This is the MOST reliable cross-browser pattern: clicking a label
        natively triggers the associated input — no JavaScript .click() needed.
        Works on ALL browsers including mobile Safari, Firefox, etc.
      */}
      <label
        htmlFor="sapphire-file-input"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={`
          relative w-full max-w-xl aspect-[4/3] rounded-2xl border-2 border-dashed
          flex flex-col items-center justify-center gap-6
          transition-all duration-300 ease-out
          ${isLoading
            ? "cursor-wait border-gold/50 bg-gold/5"
            : "cursor-pointer border-sapphire-lighter hover:border-gold/50 hover:bg-sapphire-light/30"
          }
          ${isDragging ? "border-gold bg-gold/5 scale-[1.02]" : ""}
        `}
      >
        {/* Inner glow when dragging or loading */}
        {(isDragging || isLoading) && (
          <div className="absolute inset-0 rounded-2xl bg-gold/5 blur-xl pointer-events-none" />
        )}

        <div
          className={`
          p-5 rounded-2xl transition-all duration-300
          ${isLoading ? "bg-gold/10" : isDragging ? "bg-gold/10" : "bg-sapphire-light/50"}
        `}
        >
          {isLoading ? (
            <Loader2 className="w-12 h-12 text-gold animate-spin" strokeWidth={1.5} />
          ) : isDragging ? (
            <ImagePlus className="w-12 h-12 text-gold" strokeWidth={1.5} />
          ) : (
            <Upload className="w-12 h-12 text-muted-foreground" strokeWidth={1.5} />
          )}
        </div>

        <div className="text-center space-y-2 relative z-10">
          <p className="text-lg font-medium text-foreground">
            {isLoading ? "Loading image..." : isDragging ? "Drop your image here" : "Drop image here or click to upload"}
          </p>
          <p className="text-sm text-muted-foreground">
            {isLoading ? "Please wait" : "PNG, JPG, WebP — max 20MB"}
          </p>
        </div>

        {/* Decorative gold corners */}
        <div className="absolute top-3 left-3 w-6 h-6 border-t-2 border-l-2 border-gold/30 rounded-tl-lg pointer-events-none" />
        <div className="absolute top-3 right-3 w-6 h-6 border-t-2 border-r-2 border-gold/30 rounded-tr-lg pointer-events-none" />
        <div className="absolute bottom-3 left-3 w-6 h-6 border-b-2 border-l-2 border-gold/30 rounded-bl-lg pointer-events-none" />
        <div className="absolute bottom-3 right-3 w-6 h-6 border-b-2 border-r-2 border-gold/30 rounded-br-lg pointer-events-none" />
      </label>
    </div>
  );
}
