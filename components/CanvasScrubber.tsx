import React, { useEffect, useRef, useState } from 'react';

interface CanvasScrubberProps {
  frameCount: number;
  framePath: (index: number) => string;
}

export default function CanvasScrubber({ frameCount, framePath }: CanvasScrubberProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [images, setImages] = useState<HTMLImageElement[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Preload images
  useEffect(() => {
    let loadedCount = 0;
    const imgs: HTMLImageElement[] = [];
    
    for (let i = 1; i <= frameCount; i++) {
      const img = new Image();
      img.src = framePath(i);
      img.onload = () => {
        loadedCount++;
        if (loadedCount === frameCount) {
          setImages(imgs);
          setLoaded(true);
        }
      };
      imgs.push(img);
    }
  }, [frameCount, framePath]);

  // Handle scroll and render
  useEffect(() => {
    if (!loaded || !canvasRef.current || images.length === 0) return;

    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');
    if (!context) return;

    let animationFrameId: number;

    const render = () => {
      const html = document.documentElement;
      // Calculate scroll progress (0 to 1) for the entire page as an example
      const maxScroll = Math.max(1, html.scrollHeight - html.clientHeight);
      const scrollFraction = Math.max(0, Math.min(1, html.scrollTop / maxScroll));
      
      const frameIndex = Math.min(
        frameCount - 1,
        Math.floor(scrollFraction * frameCount)
      );

      // Draw current frame
      const img = images[frameIndex];
      if (img) {
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(img, 0, 0, canvas.width, canvas.height);
      }

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [loaded, images, frameCount]);

  return (
    <div className="relative w-full h-full min-h-screen flex items-center justify-center bg-black">
      {!loaded && <div className="absolute text-white">Loading frames...</div>}
      <canvas
        ref={canvasRef}
        width={1920}
        height={1080}
        className="w-full h-auto max-w-full"
      />
    </div>
  );
}
