import { useEffect, useRef, useState } from 'react';
import { Renderer, type PickHit, type ViewPadding } from '../viewer/renderer';
import { buildScene, type Layer } from '../viewer/scene';

interface Props {
  /** What to draw. Null clears the view. */
  layers: Layer[] | null;
  /** Re-frame the camera whenever this value changes (normally the structure id). */
  fitKey: string;
  /** Glowing markers: x, y, z, radius for each. */
  highlights?: Float32Array;
  spin?: boolean;
  padding?: ViewPadding;
  interactive?: boolean;
  label: string;
  onHover?: (hit: PickHit | null, clientX: number, clientY: number) => void;
  onPick?: (hit: PickHit | null) => void;
  /** Receives the renderer once it exists (and null when it goes away). */
  onRenderer?: (renderer: Renderer | null) => void;
}

const NO_HIGHLIGHTS = new Float32Array(0);

/** A canvas driven by the WebGL renderer. */
export function StructureCanvas({ layers, fitKey, highlights = NO_HIGHLIGHTS, spin = false, padding, interactive = true, label, onHover, onPick, onRenderer }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const lastFit = useRef<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const hoverRef = useRef(onHover);
  const pickRef = useRef(onPick);
  const readyRef = useRef(onRenderer);
  hoverRef.current = onHover;
  pickRef.current = onPick;
  readyRef.current = onRenderer;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: Renderer;
    try {
      renderer = new Renderer(canvas, { interactive });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'The 3D view could not start.');
      return;
    }
    renderer.onHover = (hit, x, y) => hoverRef.current?.(hit, x, y);
    renderer.onPick = (hit) => pickRef.current?.(hit);
    rendererRef.current = renderer;
    lastFit.current = null;
    readyRef.current?.(renderer);
    return () => {
      readyRef.current?.(null);
      rendererRef.current = null;
      renderer.dispose();
    };
  }, [interactive]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const scene = buildScene(layers ?? []);
    const fit = lastFit.current !== fitKey && !scene.empty;
    if (fit) lastFit.current = fitKey;
    renderer.setScene(scene, fit);
  }, [layers, fitKey, failure, interactive]);

  useEffect(() => {
    rendererRef.current?.setHighlights(highlights);
  }, [highlights, interactive]);

  useEffect(() => {
    rendererRef.current?.setSpin(spin);
  }, [spin, interactive]);

  const { left = 0, right = 0, top = 0, bottom = 0 } = padding ?? {};
  useEffect(() => {
    rendererRef.current?.setPadding({ left, right, top, bottom });
  }, [left, right, top, bottom, interactive]);

  if (failure) {
    return (
      <div className="canvas-failure" role="alert">
        <p>{failure}</p>
        <p>Try a current version of Chrome, Edge, Firefox or Safari with hardware acceleration turned on.</p>
      </div>
    );
  }
  return <canvas ref={canvasRef} className={interactive ? 'structure-canvas structure-canvas-interactive' : 'structure-canvas'} role="img" aria-label={label} />;
}
