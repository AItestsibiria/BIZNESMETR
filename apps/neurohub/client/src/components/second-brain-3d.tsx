// v304 component: SecondBrain3D (Eugene 2026-05-17 Босс «Второй мозг 3D —
// облако точек типа Siri, кликабельные узлы → ветки → обратно»).
//
// Облако точек = force-directed 3D graph над данными brain-export. Узлы
// окрашены по группе (фирменная палитра MuzaAi), толщина ребра = weight,
// клик по узлу → info-panel справа (slide-in), breadcrumbs history,
// кнопка «← Назад» возвращает к предыдущему узлу.
//
// Reuse-working-solutions rule: данные берём из /api/admin/v304/brain-export
// (master-dashboard plugin). Никаких новых endpoint'ов не плодим.
//
// Brand-style consistency rule:
//   - Цвета узлов из brand palette (Cyber Violet / Electric Blue / Neon
//     Green / Hot Magenta / Amber Glow).
//   - Glass-card для info-panel, font-display для title, font-mono для
//     метрик / IDs.
//   - Backdrop: deep space (#0a0a17) full-screen.
//
// Mobile-friendly:
//   - Touch gestures (1 finger orbit, 2 fingers pinch) — 3d-force-graph
//     даёт их из коробки через OrbitControls.
//   - Info-panel: на mobile это bottom-sheet drawer (max-h-[60vh] absolute
//     bottom-0), на desktop — right-side panel.
//
// Voice integration (Eugene Босс «focus_brain_node admin-tool»):
//   - Слушаем window event 'brain-focus-node' с detail.nodeId, scroll'им
//     камеру к узлу. Event эмитит MusaVoiceFab при получении actions
//     результата с tool=focus_brain_node.
//
// Lazy-load: компонент сам импортируется через React.lazy() из admin-v304,
// поэтому three.js + 3d-force-graph chunk (~500KB) не попадает в main bundle.

import { useEffect, useRef, useState, useMemo } from "react";
import SpriteText from "three-spritetext";

// Динамический импорт 3d-force-graph внутри useEffect, чтобы three не
// тащился в SSR / первый paint (defensive — но Vite сам split'ит).
type ForceGraph3DInstance = any;

type BrainNode = {
  id: string;
  group: "core" | "plugin" | "channel" | "provider" | "metric" | string;
  label: string;
  status: "green" | "yellow" | "red" | "unknown";
  metrics?: Record<string, number | string>;
};

type BrainEdge = {
  from: string;
  to: string;
  weight?: number;
  kind?: string;
};

type BrainExport = {
  generatedAt: string;
  period: string;
  since: string;
  nodes: BrainNode[];
  edges: BrainEdge[];
  summary: {
    totals: Record<string, number>;
    health: { green: number; yellow: number; red: number; unknown: number };
  };
};

type GraphNode = BrainNode & {
  x?: number;
  y?: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
};

type GraphLink = {
  source: string | GraphNode;
  target: string | GraphNode;
  kind?: string;
  weight?: number;
};

// Brand palette — Cyber Violet / Electric Blue / Neon Green / Hot Magenta / Amber Glow
function colorByGroup(group: string, status: string): string {
  if (status === "red") return "#FF006E"; // Hot Magenta — alert
  if (status === "yellow") return "#FBBF24"; // Amber Glow — warning
  // Group → primary palette
  switch (group) {
    case "core":
      return "#7C3AED"; // Cyber Violet
    case "plugin":
      return "#00D4FF"; // Electric Blue
    case "channel":
      return "#FF006E"; // Hot Magenta
    case "provider":
      return "#FBBF24"; // Amber Glow
    case "metric":
      return "#39FF14"; // Neon Green
    default:
      return "#7C3AED";
  }
}

function statusEmoji(s: string): string {
  return s === "green" ? "🟢" : s === "yellow" ? "🟡" : s === "red" ? "🔴" : "⚪";
}

// Hook fetch /api/admin/v304/brain-export (admin-only)
function useBrainExport(): { data: BrainExport | null; error: string | null; loading: boolean } {
  const [data, setData] = useState<BrainExport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/v304/brain-export");
        const j = await res.json();
        if (cancelled) return;
        if (j.error) {
          setError(j.error);
        } else {
          setData(j.data);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "fetch failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, error, loading };
}

// WebGL detection (для 2D fallback)
function hasWebGL(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    return !!gl;
  } catch {
    return false;
  }
}

export default function SecondBrain3D() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<ForceGraph3DInstance | null>(null);
  const { data, error, loading } = useBrainExport();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "green" | "yellow" | "red">("all");
  const [is2DFallback, setIs2DFallback] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  // Detect mobile
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // WebGL check
  useEffect(() => {
    if (!hasWebGL()) setIs2DFallback(true);
  }, []);

  // Transform brain-export to graph format (filtered)
  const graphData = useMemo(() => {
    if (!data) return { nodes: [] as GraphNode[], links: [] as GraphLink[] };
    const q = search.trim().toLowerCase();
    const allowedIds = new Set(
      data.nodes
        .filter(n => statusFilter === "all" || n.status === statusFilter)
        .filter(n => !q || n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q))
        .map(n => n.id),
    );
    const nodes: GraphNode[] = data.nodes.filter(n => allowedIds.has(n.id));
    const links: GraphLink[] = data.edges
      .filter(e => allowedIds.has(e.from) && allowedIds.has(e.to))
      .map(e => ({ source: e.from, target: e.to, kind: e.kind, weight: e.weight }));
    return { nodes, links };
  }, [data, search, statusFilter]);

  // Init 3d-force-graph
  useEffect(() => {
    if (loading || !data || !containerRef.current || is2DFallback) return;
    let destroyed = false;
    let rotateAnimationId: number | null = null;

    (async () => {
      const mod = await import("3d-force-graph");
      if (destroyed) return;
      const ForceGraph3D = mod.default;

      // 3d-force-graph >=1.80 — constructor pattern: new ForceGraph3D(element).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Graph: any = new (ForceGraph3D as any)(containerRef.current!)
        .backgroundColor("#0a0a17")
        .nodeId("id")
        .nodeLabel((n: GraphNode) => `${statusEmoji(n.status)} ${n.label}`)
        .nodeAutoColorBy("group")
        .nodeThreeObject((n: GraphNode) => {
          const sprite = new SpriteText(n.label);
          sprite.color = colorByGroup(n.group, n.status);
          sprite.textHeight = n.group === "core" ? 6 : 4;
          sprite.fontFace = "Inter, sans-serif";
          sprite.fontWeight = "bold";
          sprite.padding = 2;
          sprite.borderRadius = 4;
          // Halo glow via material on backdrop sprite — using built-in
          // strokeColor for outline + backgroundColor для glassmorphism feel
          sprite.strokeColor = colorByGroup(n.group, n.status);
          sprite.strokeWidth = 0.5;
          sprite.backgroundColor = "rgba(10,10,23,0.65)";
          return sprite;
        })
        .nodeThreeObjectExtend(false)
        .linkColor((l: GraphLink) => {
          if (l.kind === "depends-on") return "rgba(124,58,237,0.5)"; // purple
          if (l.kind === "emits-to") return "rgba(0,212,255,0.5)"; // cyan
          if (l.kind === "reads-from") return "rgba(57,255,20,0.4)"; // green
          return "rgba(255,255,255,0.25)";
        })
        .linkWidth((l: GraphLink) => (l.weight ? 0.5 + Math.min(2, l.weight / 10) : 0.5))
        .linkDirectionalParticles(2)
        .linkDirectionalParticleSpeed(0.005)
        .linkDirectionalParticleColor((l: GraphLink) => {
          if (l.kind === "depends-on") return "#7C3AED";
          if (l.kind === "emits-to") return "#00D4FF";
          if (l.kind === "reads-from") return "#39FF14";
          return "#FFFFFF";
        })
        .onNodeClick((n: GraphNode) => {
          setSelectedId(prev => {
            if (prev && prev !== n.id) setHistory(h => [...h, prev]);
            return n.id;
          });
          // Fly camera to node
          const distance = 80;
          const distRatio = 1 + distance / Math.hypot(n.x || 1, n.y || 1, n.z || 1);
          Graph.cameraPosition(
            {
              x: (n.x || 0) * distRatio,
              y: (n.y || 0) * distRatio,
              z: (n.z || 0) * distRatio,
            },
            n,
            1500,
          );
        })
        .onLinkClick((l: GraphLink) => {
          const fromId = typeof l.source === "string" ? l.source : l.source.id;
          const toId = typeof l.target === "string" ? l.target : l.target.id;
          const kind = l.kind || "связь";
          // eslint-disable-next-line no-alert
          alert(`Поток данных: ${fromId} → ${toId}\nТип: ${kind}`);
        })
        .graphData(graphData);

      // Force tuning — нежные, не дёргают мозг
      try {
        Graph.d3Force("charge")?.strength(-120);
        Graph.d3Force("link")?.distance(60);
      } catch {
        // ignore — defensive (different d3-force versions)
      }

      graphRef.current = Graph;

      // Auto-rotate в idle — 5°/сек = ~0.087 rad/sec
      let angle = 0;
      const radius = 300;
      let lastInteraction = Date.now();
      let interactingByUser = false;
      const markInteraction = () => {
        lastInteraction = Date.now();
      };
      containerRef.current?.addEventListener("mousedown", markInteraction);
      containerRef.current?.addEventListener("touchstart", markInteraction);
      containerRef.current?.addEventListener("wheel", markInteraction);

      const tick = () => {
        if (destroyed) return;
        const idle = Date.now() - lastInteraction > 3000;
        if (idle && !interactingByUser) {
          angle += (Math.PI / 180) * 0.05; // ~3°/sec
          Graph.cameraPosition({
            x: radius * Math.sin(angle),
            z: radius * Math.cos(angle),
          });
        }
        rotateAnimationId = requestAnimationFrame(tick);
      };
      rotateAnimationId = requestAnimationFrame(tick);
    })().catch(err => {
      console.error("[SecondBrain3D] init failed:", err);
      setIs2DFallback(true);
    });

    return () => {
      destroyed = true;
      if (rotateAnimationId !== null) cancelAnimationFrame(rotateAnimationId);
      try {
        graphRef.current?._destructor?.();
      } catch {
        // ignore
      }
      graphRef.current = null;
    };
  }, [loading, data, is2DFallback]);

  // Update graph data on filter / search change
  useEffect(() => {
    if (graphRef.current) {
      graphRef.current.graphData(graphData);
    }
  }, [graphData]);

  // Voice command listener — focus_brain_node tool
  useEffect(() => {
    function onFocus(e: Event) {
      const detail = (e as CustomEvent).detail as { nodeId?: string; name?: string } | undefined;
      if (!detail || !data) return;
      const term = (detail.nodeId || detail.name || "").toLowerCase();
      if (!term) return;
      const node = data.nodes.find(
        n => n.id.toLowerCase() === term ||
          n.label.toLowerCase().includes(term) ||
          n.id.toLowerCase().includes(term),
      );
      if (node && graphRef.current) {
        setSelectedId(prev => {
          if (prev && prev !== node.id) setHistory(h => [...h, prev]);
          return node.id;
        });
        const gn = graphRef.current
          .graphData()
          .nodes.find((n: GraphNode) => n.id === node.id) as GraphNode | undefined;
        if (gn) {
          const distance = 80;
          const distRatio = 1 + distance / Math.hypot(gn.x || 1, gn.y || 1, gn.z || 1);
          graphRef.current.cameraPosition(
            { x: (gn.x || 0) * distRatio, y: (gn.y || 0) * distRatio, z: (gn.z || 0) * distRatio },
            gn,
            1500,
          );
        }
      }
    }
    window.addEventListener("brain-focus-node", onFocus as EventListener);
    return () => window.removeEventListener("brain-focus-node", onFocus as EventListener);
  }, [data]);

  const selectedNode = useMemo(() => {
    if (!data || !selectedId) return null;
    return data.nodes.find(n => n.id === selectedId) || null;
  }, [data, selectedId]);

  const relatedNodes = useMemo(() => {
    if (!data || !selectedId) return [] as { node: BrainNode; kind?: string; direction: "out" | "in" }[];
    const related: { node: BrainNode; kind?: string; direction: "out" | "in" }[] = [];
    for (const e of data.edges) {
      if (e.from === selectedId) {
        const n = data.nodes.find(x => x.id === e.to);
        if (n) related.push({ node: n, kind: e.kind, direction: "out" });
      } else if (e.to === selectedId) {
        const n = data.nodes.find(x => x.id === e.from);
        if (n) related.push({ node: n, kind: e.kind, direction: "in" });
      }
    }
    return related;
  }, [data, selectedId]);

  function navigateTo(nodeId: string) {
    setSelectedId(prev => {
      if (prev) setHistory(h => [...h, prev]);
      return nodeId;
    });
    window.dispatchEvent(new CustomEvent("brain-focus-node", { detail: { nodeId } }));
  }

  function goBack() {
    setHistory(h => {
      if (h.length === 0) return h;
      const prev = h[h.length - 1];
      setSelectedId(prev);
      window.dispatchEvent(new CustomEvent("brain-focus-node", { detail: { nodeId: prev } }));
      return h.slice(0, -1);
    });
  }

  // Loading / error states
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[70vh] bg-[#0a0a17] rounded-2xl">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-purple-500 mb-4"></div>
          <p className="text-sm font-sans text-muted-foreground">Загружаем мозг...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-[70vh] bg-[#0a0a17] rounded-2xl">
        <div className="glass-card rounded-2xl p-6 border border-pink-500/30 max-w-md">
          <h3 className="text-lg font-sans font-bold text-white mb-2">Ошибка загрузки</h3>
          <p className="text-sm font-sans text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-[80vh] rounded-2xl overflow-hidden bg-[#0a0a17] border border-purple-500/20">
      {/* 3D canvas или 2D fallback */}
      {is2DFallback ? (
        <Brain2DFallback
          data={data}
          graphData={graphData}
          selectedId={selectedId}
          onNodeClick={(id) => {
            setSelectedId(prev => {
              if (prev && prev !== id) setHistory(h => [...h, prev]);
              return id;
            });
          }}
        />
      ) : (
        <div ref={containerRef} className="absolute inset-0" />
      )}

      {/* Top controls — search + filter */}
      <div className="absolute top-3 right-3 left-3 sm:left-auto flex flex-wrap gap-2 z-10">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="🔍 Поиск узла..."
          className="flex-1 sm:flex-none sm:w-64 px-3 py-2 text-sm font-sans rounded-lg bg-[#0a0a17]/80 backdrop-blur-md border border-purple-500/30 text-white placeholder-white/40 focus:outline-none focus:border-purple-400 focus:shadow-[0_0_24px_rgba(124,58,237,0.4)]"
        />
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value as "all" | "green" | "yellow" | "red")}
          className="px-3 py-2 text-sm font-sans rounded-lg bg-[#0a0a17]/80 backdrop-blur-md border border-purple-500/30 text-white focus:outline-none focus:border-purple-400"
        >
          <option value="all">Все статусы</option>
          <option value="green">🟢 Зелёные</option>
          <option value="yellow">🟡 Жёлтые</option>
          <option value="red">🔴 Красные</option>
        </select>
      </div>

      {/* Bottom legend */}
      <div className="absolute bottom-3 left-3 z-10 hidden sm:flex gap-3 text-[10px] font-sans bg-[#0a0a17]/70 backdrop-blur-md rounded-lg px-3 py-2 border border-purple-500/20">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-[#7C3AED]"></span>Core</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-[#00D4FF]"></span>Plugin</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-[#FF006E]"></span>Channel</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-[#FBBF24]"></span>Provider</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-[#39FF14]"></span>Metric</span>
      </div>

      {/* Health summary */}
      {data && (
        <div className="absolute bottom-3 right-3 z-10 text-[10px] font-mono bg-[#0a0a17]/70 backdrop-blur-md rounded-lg px-3 py-2 border border-purple-500/20 text-white/80">
          🟢{data.summary.health.green} · 🟡{data.summary.health.yellow} · 🔴{data.summary.health.red} · узлов {data.summary.totals.nodes} · связей {data.summary.totals.edges}
        </div>
      )}

      {/* Info panel — desktop right side, mobile bottom sheet */}
      {selectedNode && (
        <InfoPanel
          node={selectedNode}
          relatedNodes={relatedNodes}
          historyDepth={history.length}
          isMobile={isMobile}
          onNavigate={navigateTo}
          onBack={goBack}
          onClose={() => {
            setSelectedId(null);
            setHistory([]);
          }}
        />
      )}
    </div>
  );
}

// ===== Info Panel (slide-in right или bottom-sheet) =====

function InfoPanel({
  node,
  relatedNodes,
  historyDepth,
  isMobile,
  onNavigate,
  onBack,
  onClose,
}: {
  node: BrainNode;
  relatedNodes: { node: BrainNode; kind?: string; direction: "out" | "in" }[];
  historyDepth: number;
  isMobile: boolean;
  onNavigate: (id: string) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const color = colorByGroup(node.group, node.status);
  const panelClasses = isMobile
    ? "absolute bottom-0 left-0 right-0 max-h-[60vh] rounded-t-2xl overflow-y-auto"
    : "absolute top-16 right-3 bottom-16 w-80 rounded-2xl overflow-y-auto";

  return (
    <div
      className={`${panelClasses} z-20 glass-card border border-purple-500/30 shadow-[0_0_32px_rgba(124,58,237,0.3)] animate-in slide-in-from-right`}
      data-testid="brain-info-panel"
    >
      <div className="p-4 space-y-3">
        {/* Header */}
        <div className="flex items-start gap-2">
          <span
            className="inline-block w-3 h-3 rounded-full mt-1.5 flex-shrink-0"
            style={{ background: color, boxShadow: `0 0 12px ${color}` }}
          ></span>
          <div className="flex-1 min-w-0">
            <h3 className="text-lg font-display font-bold text-white truncate">{node.label}</h3>
            <p className="text-[10px] font-mono text-white/50">{node.id}</p>
          </div>
          <button
            onClick={onClose}
            className="text-white/60 hover:text-white text-xl leading-none px-1"
            aria-label="Закрыть"
            data-testid="brain-info-close"
          >
            ×
          </button>
        </div>

        {/* Status + group pills */}
        <div className="flex flex-wrap gap-2">
          <span className="text-[10px] font-sans px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 font-medium">
            {node.group}
          </span>
          <span className="text-[10px] font-sans px-2 py-0.5 rounded-full bg-white/10 text-white/80 font-medium">
            {statusEmoji(node.status)} {node.status}
          </span>
        </div>

        {/* Breadcrumbs / back */}
        {historyDepth > 0 && (
          <button
            onClick={onBack}
            className="text-xs font-sans text-cyan-300 hover:text-cyan-200 flex items-center gap-1"
            data-testid="brain-info-back"
          >
            ← Назад ({historyDepth})
          </button>
        )}

        {/* Metrics */}
        {node.metrics && Object.keys(node.metrics).length > 0 && (
          <div className="space-y-1">
            <h4 className="text-xs font-sans font-bold text-white/80">Метрики</h4>
            <div className="grid grid-cols-2 gap-1 text-[11px]">
              {Object.entries(node.metrics).map(([k, v]) => (
                <div key={k} className="rounded-md bg-white/5 px-2 py-1 border border-white/5">
                  <div className="text-[9px] font-sans text-white/50 uppercase">{k}</div>
                  <div className="font-mono text-white truncate">{String(v)}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Related nodes */}
        {relatedNodes.length > 0 && (
          <div className="space-y-1">
            <h4 className="text-xs font-sans font-bold text-white/80">
              Связанные узлы ({relatedNodes.length})
            </h4>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {relatedNodes.map((r, idx) => (
                <button
                  key={`${r.node.id}-${idx}`}
                  onClick={() => onNavigate(r.node.id)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md bg-white/5 hover:bg-purple-500/20 border border-white/5 hover:border-purple-400/30 transition-colors text-left"
                  data-testid={`brain-related-${r.node.id}`}
                >
                  <span
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ background: colorByGroup(r.node.group, r.node.status) }}
                  ></span>
                  <span className="text-[11px] font-sans text-white/90 flex-1 truncate">
                    {r.node.label}
                  </span>
                  <span className="text-[9px] font-mono text-white/40">
                    {r.direction === "out" ? "→" : "←"} {r.kind || ""}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ===== 2D Fallback (если WebGL недоступен) =====

function Brain2DFallback({
  data,
  graphData,
  selectedId,
  onNodeClick,
}: {
  data: BrainExport | null;
  graphData: { nodes: GraphNode[]; links: GraphLink[] };
  selectedId: string | null;
  onNodeClick: (id: string) => void;
}) {
  if (!data) return null;
  const groups = ["core", "plugin", "channel", "provider", "metric"];
  return (
    <div className="absolute inset-0 overflow-auto p-4">
      <div className="text-xs font-sans text-amber-300 mb-3">
        ⚠️ WebGL не поддерживается — показан 2D-режим
      </div>
      <div className="space-y-4">
        {groups.map(g => {
          const items = graphData.nodes.filter(n => n.group === g);
          if (items.length === 0) return null;
          return (
            <div key={g}>
              <h4 className="text-xs font-sans font-bold text-white/80 mb-2 uppercase">{g}</h4>
              <div className="flex flex-wrap gap-2">
                {items.map(n => (
                  <button
                    key={n.id}
                    onClick={() => onNodeClick(n.id)}
                    className={`px-2 py-1 rounded-lg border text-xs font-sans transition-colors ${
                      selectedId === n.id ? "border-purple-400 shadow-[0_0_12px_rgba(124,58,237,0.4)]" : "border-white/10"
                    }`}
                    style={{ background: `${colorByGroup(n.group, n.status)}22`, color: colorByGroup(n.group, n.status) }}
                  >
                    {statusEmoji(n.status)} {n.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
