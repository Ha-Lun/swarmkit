import React, { useEffect, useRef, useState, useCallback } from 'react';

export interface CanvasScrubberManifest {
  frameCount: number;
  width: number;
  height: number;
  fps?: number;
  format?: string;
  framePattern?: string;
  samplePath?: string;
  generatedAt?: string;
}

export interface CanvasScrubberProps {
  /** Total number of frames in the sequence (overridden by manifestUrl if provided) */
  frameCount?: number;
  /** Function returning the URL/path for a 1-indexed frame number */
  framePath?: (index: number) => string;
  /** Optional URL to manifest.json (e.g. "/frames/manifest.json") */
  manifestUrl?: string;
  /** Base width for aspect ratio calculation (default: 1920 or manifest width) */
  width?: number;
  /** Base height for aspect ratio calculation (default: 1080 or manifest height) */
  height?: number;
  /** Custom container CSS classes */
  className?: string;
  /** Custom loading element */
  loadingComponent?: React.ReactNode;
  /** Callback fired with preloading progress percentage (0-100) */
  onProgress?: (percent: number) => void;
  /** Callback fired once all frames are preloaded and ready */
  onLoaded?: () => void;
}

export default function CanvasScrubber({
  frameCount: propFrameCount,
  framePath: propFramePath,
  manifestUrl,
  width: propWidth,
  height: propHeight,
  className = '',
  loadingComponent,
  onProgress,
  onLoaded,
}: CanvasScrubberProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [images, setImages] = useState<HTMLImageElement[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadPercent, setLoadPercent] = useState(0);
  const [manifest, setManifest] = useState<CanvasScrubberManifest | null>(null);

  // Determine effective frame count and dimensions
  const effectiveFrameCount = manifest?.frameCount ?? propFrameCount ?? 0;
  const canvasNativeWidth = manifest?.width ?? propWidth ?? 1920;
  const canvasNativeHeight = manifest?.height ?? propHeight ?? 1080;

  // Derive framePath function
  const effectiveFramePath = useCallback(
    (index: number): string => {
      if (propFramePath) {
        return propFramePath(index);
      }
      if (manifestUrl) {
        const basePath = manifestUrl.substring(0, manifestUrl.lastIndexOf('/') + 1);
        const format = manifest?.format || 'webp';
        const paddedIndex = String(index).padStart(4, '0');
        return `${basePath}frame_${paddedIndex}.${format}`;
      }
      return `/frames/frame_${String(index).padStart(4, '0')}.webp`;
    },
    [propFramePath, manifestUrl, manifest]
  );

  // 1. Fetch manifest if URL provided
  useEffect(() => {
    if (!manifestUrl) return;

    let isMounted = true;
    fetch(manifestUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to fetch manifest: ${res.statusText}`);
        return res.json() as Promise<CanvasScrubberManifest>;
      })
      .then((data) => {
        if (isMounted) {
          setManifest(data);
        }
      })
      .catch((err) => {
        console.warn('CanvasScrubber: Could not load manifest, falling back to props:', err);
      });

    return () => {
      isMounted = false;
    };
  }, [manifestUrl]);

  // 2. Preload all frames
  useEffect(() => {
    if (effectiveFrameCount <= 0) return;

    let loadedCount = 0;
    let isMounted = true;
    const imgs: HTMLImageElement[] = new Array(effectiveFrameCount);

    setLoaded(false);
    setLoadPercent(0);

    for (let i = 1; i <= effectiveFrameCount; i++) {
      const img = new Image();
      img.src = effectiveFramePath(i);

      img.onload = () => {
        if (!isMounted) return;
        loadedCount++;
        const pct = Math.round((loadedCount / effectiveFrameCount) * 100);
        setLoadPercent(pct);
        if (onProgress) onProgress(pct);

        if (loadedCount === effectiveFrameCount) {
          setImages(imgs);
          setLoaded(true);
          if (onLoaded) onLoaded();
        }
      };

      img.onerror = () => {
        if (!isMounted) return;
        console.warn(`Failed to load frame ${i} at ${img.src}`);
        loadedCount++;
        if (loadedCount === effectiveFrameCount) {
          setImages(imgs);
          setLoaded(true);
          if (onLoaded) onLoaded();
        }
      };

      imgs[i - 1] = img;
    }

    return () => {
      isMounted = false;
    };
  }, [effectiveFrameCount, effectiveFramePath, onProgress, onLoaded]);

  // 3. Scroll tracking and canvas drawing with DPR scaling
  useEffect(() => {
    if (!loaded || !canvasRef.current || images.length === 0) return;

    const canvas = canvasRef.current;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return;

    let animationFrameId: number;

    const render = () => {
      const html = document.documentElement;
      const maxScroll = Math.max(1, html.scrollHeight - html.clientHeight);
      const scrollFraction = Math.max(0, Math.min(1, html.scrollTop / maxScroll));

      const frameIndex = Math.min(
        effectiveFrameCount - 1,
        Math.floor(scrollFraction * effectiveFrameCount)
      );

      const img = images[frameIndex];
      if (img && img.complete && img.naturalWidth > 0) {
        context.drawImage(img, 0, 0, canvas.width, canvas.height);
      }

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [loaded, images, effectiveFrameCount]);

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full min-h-screen flex items-center justify-center bg-black overflow-hidden ${className}`}
    >
      {!loaded && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 z-20 text-white space-y-3">
          {loadingComponent ? (
            loadingComponent
          ) : (
            <>
              <div className="w-12 h-12 border-4 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin" />
              <p className="text-sm font-medium tracking-wide">
                Loading 3D frames... {loadPercent}%
              </p>
            </>
          )}
        </div>
      )}

      <canvas
        ref={canvasRef}
        width={canvasNativeWidth}
        height={canvasNativeHeight}
        className="w-full h-auto max-w-full object-contain pointer-events-none"
        style={{
          aspectRatio: `${canvasNativeWidth} / ${canvasNativeHeight}`,
        }}
      />
    </div>
  );
}
