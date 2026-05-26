"use client";

import {
  Paintbrush,
  Eraser,
  Undo2,
  Redo2,
  Trash2,
  Sparkles,
  Download,
  ImagePlus,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Wand2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export type Tool = "brush" | "eraser";

interface ToolbarProps {
  tool: Tool;
  brushSize: number;
  zoom: number;
  canUndo: boolean;
  canRedo: boolean;
  hasMask: boolean;
  isProcessing: boolean;
  hasResult: boolean;
  onToolChange: (tool: Tool) => void;
  onBrushSizeChange: (size: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  onClearMask: () => void;
  onErase: () => void;
  onDownload: () => void;
  onNewImage: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
}

export default function Toolbar({
  tool,
  brushSize,
  zoom,
  canUndo,
  canRedo,
  hasMask,
  isProcessing,
  hasResult,
  onToolChange,
  onBrushSizeChange,
  onUndo,
  onRedo,
  onClearMask,
  onErase,
  onDownload,
  onNewImage,
  onZoomIn,
  onZoomOut,
  onZoomReset,
}: ToolbarProps) {
  return (
    <TooltipProvider delayDuration={300}>
      {/* Left sidebar — tools */}
      <div className="absolute left-4 top-1/2 -translate-y-1/2 z-20 flex flex-col items-center gap-1 bg-sapphire/90 backdrop-blur-sm rounded-xl border border-sapphire-lighter p-2 shadow-xl shadow-black/30">
        <ToolButton
          icon={<Paintbrush className="w-4 h-4" />}
          label="Brush (B)"
          active={tool === "brush"}
          onClick={() => onToolChange("brush")}
        />
        <ToolButton
          icon={<Eraser className="w-4 h-4" />}
          label="Eraser (E)"
          active={tool === "eraser"}
          onClick={() => onToolChange("eraser")}
        />

        <Separator className="bg-sapphire-lighter my-1 w-8" />

        {/* Brush size */}
        <div className="flex flex-col items-center gap-1 px-1 py-2">
          <div
            className="rounded-full border-2 flex items-center justify-center"
            style={{
              width: `${Math.min(Math.max(brushSize / 2, 8), 36)}px`,
              height: `${Math.min(Math.max(brushSize / 2, 8), 36)}px`,
              borderColor: "rgba(212, 168, 67, 0.6)",
            }}
          >
            <div
              className="rounded-full"
              style={{
                width: `${Math.min(Math.max(brushSize / 4, 4), 28)}px`,
                height: `${Math.min(Math.max(brushSize / 4, 4), 28)}px`,
                backgroundColor: "rgba(212, 168, 67, 0.8)",
              }}
            />
          </div>
          <Slider
            value={[brushSize]}
            onValueChange={([v]) => onBrushSizeChange(v)}
            min={5}
            max={100}
            step={1}
            className="w-20 [&_[role=slider]]:h-3 [&_[role=slider]]:w-3 [&_[role=slider]]:bg-gold [&_[role=slider]]:border-gold-hover"
            orientation="vertical"
          />
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {brushSize}px
          </span>
        </div>

        <Separator className="bg-sapphire-lighter my-1 w-8" />

        <ToolButton
          icon={<Undo2 className="w-4 h-4" />}
          label="Undo (Ctrl+Z)"
          disabled={!canUndo}
          onClick={onUndo}
        />
        <ToolButton
          icon={<Redo2 className="w-4 h-4" />}
          label="Redo (Ctrl+Shift+Z)"
          disabled={!canRedo}
          onClick={onRedo}
        />
        <ToolButton
          icon={<Trash2 className="w-4 h-4" />}
          label="Clear mask"
          disabled={!hasMask}
          onClick={onClearMask}
        />
      </div>

      {/* Bottom bar — actions & zoom */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 bg-sapphire/90 backdrop-blur-sm rounded-xl border border-sapphire-lighter px-4 py-2 shadow-xl shadow-black/30">
        {/* Mode indicator */}
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium bg-gold/15 text-gold">
          <Wand2 className="w-3 h-3" />
          <span>Smart Erase</span>
        </div>

        <Separator orientation="vertical" className="h-6 bg-sapphire-lighter" />

        {/* Zoom controls */}
        <div className="flex items-center gap-1 mr-2">
          <MiniButton
            icon={<ZoomOut className="w-3.5 h-3.5" />}
            label="Zoom out"
            onClick={onZoomOut}
          />
          <button
            onClick={onZoomReset}
            className="text-xs text-muted-foreground hover:text-gold transition-colors tabular-nums min-w-[3rem] text-center"
          >
            {Math.round(zoom * 100)}%
          </button>
          <MiniButton
            icon={<ZoomIn className="w-3.5 h-3.5" />}
            label="Zoom in"
            onClick={onZoomIn}
          />
          <MiniButton
            icon={<RotateCcw className="w-3.5 h-3.5" />}
            label="Reset zoom"
            onClick={onZoomReset}
          />
        </div>

        <Separator orientation="vertical" className="h-6 bg-sapphire-lighter" />

        {/* Main action */}
        <Button
          onClick={onErase}
          disabled={!hasMask || isProcessing}
          className="bg-gold hover:bg-gold-hover text-sapphire-dark font-semibold px-5 gap-2 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          size="sm"
        >
          <Sparkles className="w-4 h-4" />
          {isProcessing ? "Erasing..." : "Erase"}
        </Button>

        {hasResult && (
          <Button
            onClick={onDownload}
            className="bg-sapphire-light hover:bg-sapphire-lighter text-foreground gap-2 border border-gold/30 transition-all"
            size="sm"
          >
            <Download className="w-4 h-4" />
            Download
          </Button>
        )}

        <Separator orientation="vertical" className="h-6 bg-sapphire-lighter" />

        <MiniButton
          icon={<ImagePlus className="w-3.5 h-3.5" />}
          label="New image"
          onClick={onNewImage}
        />
      </div>
    </TooltipProvider>
  );
}

function ToolButton({
  icon,
  label,
  active,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          disabled={disabled}
          className={`
            p-2 rounded-lg transition-all duration-150
            ${
              active
                ? "bg-gold/20 text-gold shadow-inner"
                : "text-muted-foreground hover:text-foreground hover:bg-sapphire-light/50"
            }
            ${disabled ? "opacity-30 cursor-not-allowed" : "cursor-pointer"}
          `}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="right"
        className="bg-sapphire-light text-foreground border-sapphire-lighter text-xs"
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function MiniButton({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-sapphire-light/50 transition-all cursor-pointer"
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className="bg-sapphire-light text-foreground border-sapphire-lighter text-xs"
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
