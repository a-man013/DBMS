"use client";

import { useEffect, useRef, useState, useMemo } from "react";

// ── Color utilities ──────────────────────────────────────────────────

/** Risk-score → HSL color: 0 = green (120°), 50 = yellow (60°), 100 = red (0°). */
function riskColor(score) {
  const s = Math.max(0, Math.min(100, score || 0));
  const hue = Math.round(120 * (1 - s / 100));
  return `hsl(${hue}, 90%, 55%)`;
}

/** Golden-angle cluster color. */
function clusterColor(clusterId) {
  const hue = (clusterId * 137.508) % 360;
  return `hsl(${Math.round(hue)}, 70%, 55%)`;
}

/** Parse an `hsl(h, s%, l%)` string into { r, g, b } 0-255. */
function parseColor(str) {
  const m = str.match(/hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/);
  if (m) return hslToRgb(parseFloat(m[1]) / 360, parseFloat(m[2]) / 100, parseFloat(m[3]) / 100);
  return { r: 100, g: 100, b: 255 };
}

function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

// ── Glow texture ─────────────────────────────────────────────────────

function createGlowTexture(color, intensity = 1, size = 128) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const { r, g, b } = parseColor(color);
  const cx = size / 2;
  const rad = size / 2;

  const grad = ctx.createRadialGradient(cx, cx, 0, cx, cx, rad);
  const a = Math.min(1, 0.6 + intensity * 0.4);
  grad.addColorStop(0, `rgba(${r},${g},${b},${a})`);
  grad.addColorStop(0.25, `rgba(${r},${g},${b},${a * 0.7})`);
  grad.addColorStop(0.55, `rgba(${r},${g},${b},${a * 0.25})`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`);

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

// ── Component ────────────────────────────────────────────────────────

export default function GraphViewer3D({
  elements,
  onNodeClick,
  highlightedNodes = [],
  highlightPath = [],
  volumeThreshold = 0,
  colorMode = "risk", // "risk" | "cluster"
  animateTime = false,
  style,
}) {
  const containerRef = useRef(null);
  const graphRef = useRef(null);
  const animFrameRef = useRef(null);
  const [ForceGraph3DModule, setForceGraph3DModule] = useState(null);

  // Dynamically import 3d-force-graph (not SSR-compatible)
  useEffect(() => {
    let cancelled = false;
    import("3d-force-graph").then((mod) => {
      if (!cancelled) setForceGraph3DModule(() => mod.default);
    });
    return () => { cancelled = true; };
  }, []);

  // Expose THREE globally
  useEffect(() => {
    import("three").then((THREE) => { window.__THREE__ = THREE; });
  }, []);

  // ── Data transformation ──────────────────────────────────────────
  const graphData = useMemo(() => {
    if (!elements) return { nodes: [], links: [] };

    const nodeMap = new Map();
    const nodes = [];
    const links = [];

    // ── Node size scale factor ──
    // nodeSize = 3 + sqrt(totalVolume) / scaleFactor
    // Choose scaleFactor so the largest node ≈ 16 units
    let maxVol = 0;
    for (const n of elements.nodes || []) {
      const v = parseFloat(n.data?.totalVolume ?? n.data?.value_lossless ?? 0);
      if (v > maxVol) maxVol = v;
    }
    const scaleFactor = maxVol > 0 ? Math.sqrt(maxVol) / 13 : 1;

    // ── Edge width scale ──
    let maxLogAmt = 0;
    for (const e of elements.edges || []) {
      const la = parseFloat(e.data?.logAmount ?? 0);
      if (la > maxLogAmt) maxLogAmt = la;
    }
    const edgeWidthScale = maxLogAmt > 0 ? 4 / maxLogAmt : 1; // max visual width ≈ 4

    for (const n of elements.nodes || []) {
      const normVol = parseFloat(n.data?.normalizedVolume ?? 0);
      const totalVol = parseFloat(n.data?.totalVolume ?? n.data?.value_lossless ?? 0);
      const logVol = parseFloat(n.data?.logVolume ?? 0);
      const risk = n.data?.riskScore || 0;
      const clusterId = n.data?.clusterId ?? -1;

      // Threshold filter on normalized log volume
      if (volumeThreshold > 0 && normVol < volumeThreshold) continue;

      const isHighlighted =
        highlightedNodes.includes(n.data.id) || highlightedNodes.includes(n.data.label);
      const isOnPath =
        highlightPath.includes(n.data.id) || highlightPath.includes(n.data.label);

      // ── Color ──
      let color;
      if (isOnPath) {
        color = "hsl(45, 100%, 60%)"; // gold
      } else if (isHighlighted) {
        color = "hsl(0, 85%, 55%)"; // red
      } else if (colorMode === "cluster" && clusterId >= 0) {
        color = clusterColor(clusterId);
      } else {
        color = riskColor(risk); // green→yellow→red by risk
      }

      // ── Size (economic importance) ──
      const nodeSize = 3 + Math.sqrt(totalVol) / scaleFactor;

      const node = {
        id: n.data.id,
        label: n.data.label || n.data.id,
        nodeType: n.data.nodeType,
        totalVolume: totalVol,
        logVolume: logVol,
        normalizedVolume: normVol,
        riskScore: risk,
        clusterId,
        color,
        isHighlighted,
        isOnPath,
        // Z driven by normalized log volume
        fz: normVol * 300 - 150,
        nodeSize,
        glowIntensity: normVol, // 0..1
      };
      nodes.push(node);
      nodeMap.set(n.data.id, node);
    }

    for (const e of elements.edges || []) {
      if (!nodeMap.has(e.data.source) || !nodeMap.has(e.data.target)) continue;

      const isPathEdge =
        highlightPath.length > 1 &&
        highlightPath.includes(e.data.source) &&
        highlightPath.includes(e.data.target);

      const logAmt = parseFloat(e.data?.logAmount ?? 0);

      links.push({
        source: e.data.source,
        target: e.data.target,
        edgeType: e.data.edgeType,
        amount: e.data.amount,
        label: e.data.label,
        normalizedTime: parseFloat(e.data?.normalizedTime ?? 0),
        color: isPathEdge ? "rgba(245, 158, 11, 0.8)" : "rgba(55, 65, 81, 0.35)",
        width: isPathEdge ? 3 : Math.max(0.3, logAmt * edgeWidthScale),
        isPathEdge,
      });
    }

    return { nodes, links };
  }, [elements, highlightedNodes, highlightPath, volumeThreshold, colorMode]);

  // ── 3D Graph init & update ─────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || !ForceGraph3DModule) return;

    const container = containerRef.current;

    // Destroy previous instance
    if (graphRef.current) {
      graphRef.current._destructor?.();
      graphRef.current = null;
      while (container.firstChild) container.removeChild(container.firstChild);
    }

    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }

    const Graph = ForceGraph3DModule()(container)
      .backgroundColor("#0a0a0f")
      .showNavInfo(false)
      // ── Nodes ──
      .nodeThreeObject((node) => {
        const T = window.__THREE__;
        if (!T) return undefined;

        const s = node.nodeSize || 5;

        // Core sphere
        const geo = new T.SphereGeometry(s * 0.5, 16, 16);
        const { r, g, b } = parseColor(node.color);
        const mat = new T.MeshBasicMaterial({
          color: new T.Color(r / 255, g / 255, b / 255),
          transparent: true,
          opacity: 0.9,
        });
        const sphere = new T.Mesh(geo, mat);

        // Glow sprite — intensity proportional to logVolume
        const canvas = createGlowTexture(node.color, node.glowIntensity);
        const tex = new T.CanvasTexture(canvas);
        const spriteMat = new T.SpriteMaterial({
          map: tex,
          transparent: true,
          blending: T.AdditiveBlending,
          depthWrite: false,
        });
        const sprite = new T.Sprite(spriteMat);
        sprite.scale.set(s * 2.2, s * 2.2, 1);

        const group = new T.Group();
        group.add(sphere);
        group.add(sprite);
        return group;
      })
      .nodeLabel((node) => {
        const addr =
          node.label?.length > 20
            ? node.label.slice(0, 10) + "\u2026" + node.label.slice(-6)
            : node.label;
        const vol =
          node.totalVolume > 1e15
            ? (node.totalVolume / 1e18).toFixed(4) + " ETH"
            : node.totalVolume.toLocaleString() + " Wei";
        const riskHue = Math.round(120 * (1 - (node.riskScore || 0) / 100));
        return `<div style="background:rgba(0,0,0,0.88);color:#e4e4e7;padding:8px 12px;border-radius:8px;font-size:12px;font-family:monospace;border:1px solid #27272a;pointer-events:none;max-width:280px;">
          <div style="font-weight:700;margin-bottom:4px;">${addr}</div>
          <div style="color:#a1a1aa;">Volume: <span style="color:${node.color}">${vol}</span></div>
          <div style="color:#a1a1aa;">LogVol: <span style="color:#818cf8">${node.logVolume.toFixed(2)}</span></div>
          <div style="color:#a1a1aa;">Risk: <span style="color:hsl(${riskHue}, 90%, 55%)">${node.riskScore}</span></div>
          <div style="color:#a1a1aa;">Cluster: <span style="color:${clusterColor(node.clusterId)}">#${node.clusterId}</span></div>
        </div>`;
      })
      // ── Edges ──
      .linkColor((link) => link.color)
      .linkWidth((link) => link.width)
      .linkOpacity(0.6)
      .linkDirectionalParticles((link) => (link.isPathEdge ? 4 : 0))
      .linkDirectionalParticleWidth(1.5)
      .linkDirectionalParticleColor(() => "#f59e0b")
      // ── Physics ──
      .d3AlphaDecay(0.02)
      .d3VelocityDecay(0.3)
      .warmupTicks(100)
      .cooldownTicks(200)
      // ── Interaction ──
      .onNodeClick((node) => {
        if (onNodeClick && node.nodeType === "Wallet") {
          onNodeClick(node.label || node.id);
        }
      })
      .onNodeHover((node) => {
        container.style.cursor = node ? "pointer" : "default";
      });

    // Custom Z-force: bias toward normalizedVolume position
    Graph.d3Force("z", (alpha) => {
      for (const node of graphData.nodes) {
        if (node.fz !== undefined) {
          node.vz += (node.fz - (node.z || 0)) * alpha * 0.3;
        }
      }
    });

    Graph.graphData(graphData);

    // Camera
    setTimeout(() => {
      Graph.cameraPosition({ x: 0, y: 0, z: 500 }, { x: 0, y: 0, z: 0 }, 1000);
    }, 500);

    graphRef.current = Graph;

    // ── Temporal animation ───────────────────────────────────────────
    if (animateTime && graphData.links.length > 0) {
      // Start with zero links visible, then progressively reveal
      const allLinks = [...graphData.links];
      const sorted = [...allLinks].sort((a, b) => a.normalizedTime - b.normalizedTime);
      const DURATION = 8000; // 8 seconds for full timeline
      const start = performance.now();

      const tick = () => {
        const elapsed = performance.now() - start;
        const t = Math.min(1, elapsed / DURATION);
        const cutoff = sorted.findIndex((l) => l.normalizedTime > t);
        const visibleLinks = cutoff === -1 ? sorted : sorted.slice(0, cutoff);
        Graph.graphData({ nodes: graphData.nodes, links: visibleLinks });
        if (t < 1) animFrameRef.current = requestAnimationFrame(tick);
      };
      animFrameRef.current = requestAnimationFrame(tick);
    }

    // Resize
    const resizeObs = new ResizeObserver(() => {
      if (graphRef.current) {
        graphRef.current.width(container.clientWidth);
        graphRef.current.height(container.clientHeight);
      }
    });
    resizeObs.observe(container);

    return () => {
      resizeObs.disconnect();
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (graphRef.current) {
        graphRef.current._destructor?.();
        graphRef.current = null;
      }
    };
  }, [ForceGraph3DModule, graphData, onNodeClick, animateTime]);

  // ── Legend helpers ──
  const riskGradient =
    "linear-gradient(to right, hsl(120,90%,55%), hsl(60,90%,55%), hsl(0,90%,55%))";
  const clusterCount = new Set(graphData.nodes.map((n) => n.clusterId)).size;

  return (
    <div className="relative" style={style}>
      <div
        ref={containerRef}
        className="graph-container-3d"
        style={{ width: "100%", height: "100%" }}
      />

      {/* Legend */}
      <div className="absolute bottom-3 left-3 rounded-lg border border-card-border bg-card/90 px-3 py-2 backdrop-blur-sm">
        {colorMode === "risk" ? (
          <>
            <div className="mb-1 text-[10px] font-semibold text-muted uppercase tracking-wider">
              Risk Score
            </div>
            <div className="flex items-center gap-1">
              <div className="h-2 w-16 rounded-sm" style={{ background: riskGradient }} />
              <span className="text-[9px] text-muted ml-1">0 → 100</span>
            </div>
          </>
        ) : (
          <>
            <div className="mb-1 text-[10px] font-semibold text-muted uppercase tracking-wider">
              Communities ({clusterCount})
            </div>
            <div className="flex flex-wrap gap-1">
              {Array.from({ length: Math.min(clusterCount, 6) }, (_, i) => (
                <span
                  key={i}
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: clusterColor(i) }}
                />
              ))}
              {clusterCount > 6 && <span className="text-[9px] text-muted">+{clusterCount - 6}</span>}
            </div>
          </>
        )}
        <div className="mt-1 text-[10px] text-muted">
          Z-axis = log-scaled volume · Size = √volume
        </div>
        <div className="mt-1 flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full bg-yellow-400" />
          <span className="text-[9px] text-muted">Path</span>
          <span className="inline-block h-2 w-2 rounded-full bg-red-500" />
          <span className="text-[9px] text-muted">Suspicious</span>
        </div>
      </div>

      {/* Controls hint */}
      <div className="absolute bottom-3 right-3 rounded-lg border border-card-border bg-card/90 px-3 py-2 backdrop-blur-sm">
        <div className="text-[10px] text-muted">
          <span className="font-medium text-foreground">Controls:</span>{" "}
          Left-drag rotate · Right-drag pan · Scroll zoom
        </div>
      </div>
    </div>
  );
}
