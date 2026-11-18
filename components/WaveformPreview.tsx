'use client';

import { useEffect, useRef } from 'react';
import type { Segment } from '../lib/protocol';

/** Draws the ON/OFF timeline of one frame on a canvas. */
export function WaveformPreview({ segments }: { segments: Segment[] }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = 72;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const total = segments.reduce((a, s) => a + s.ms, 0) || 1;
    let x = 0;
    for (const s of segments) {
      const sw = (s.ms / total) * w;
      if (s.v === 1) {
        ctx.fillStyle = 'rgba(255, 59, 48, 0.75)';
        ctx.fillRect(x, 10, Math.max(sw, 0.6), h - 30);
      }
      x += sw;
    }

    // baseline + labels
    ctx.strokeStyle = '#273243';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h - 19.5);
    ctx.lineTo(w, h - 19.5);
    ctx.stroke();

    ctx.fillStyle = '#8b99ae';
    ctx.font = '10px ui-monospace, Consolas, monospace';
    ctx.fillText('0 s', 0, h - 6);
    const label = (total / 1000).toFixed(1) + ' s';
    ctx.fillText(label, w - ctx.measureText(label).width, h - 6);
  }, [segments]);

  return <canvas ref={ref} className="scope" aria-label="Laser waveform preview" />;
}
