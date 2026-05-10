import { useEffect, useRef, useState, useCallback } from "react";
import * as d3 from "d3";
import { feature } from "topojson-client";
type Topology = any; type GeometryCollection = any;
import type { FeatureCollection, Feature, Geometry } from "geojson";
import { getCountryName, getCountryFlag } from "@/game/countryNames";
import { supabase } from "@/integrations/supabase/client";

interface Props {
  onConfirm: (countryId: string) => void;
  lobbyId?: string | null;
  selectionEndsAt?: string | null;
}

const EXCLUDED = ["010"]; // Antarctica

export default function CountrySelect({ onConfirm, lobbyId, selectionEndsAt }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [features, setFeatures] = useState<Feature<Geometry>[]>([]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const [search, setSearch] = useState("");
  const [tooltip, setTooltip] = useState<{ x: number; y: number; name: string } | null>(null);
  const [takenCountries, setTakenCountries] = useState<Record<string, { name: string; userId: string }>>({}); // countryId -> player
  const takenCountriesRef = useRef<Record<string, { name: string; userId: string }>>({});
  const [userId, setUserId] = useState<string | null>(null);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [lockedChoice, setLockedChoice] = useState<string | null>(null);
  const lockedChoiceRef = useRef<string | null>(null);
  const hasStartedRef = useRef(false);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
  }, []);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  useEffect(() => {
    lockedChoiceRef.current = lockedChoice;
  }, [lockedChoice]);

  // Countdown ticker
  useEffect(() => {
    if (!selectionEndsAt) { setTimeLeft(null); return; }
    const end = new Date(selectionEndsAt).getTime();
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      setTimeLeft(remaining);
      if (remaining <= 0) {
        if (hasStartedRef.current) return;
        hasStartedRef.current = true;
        // Pick locked choice, current selection, or a random untaken country
        let pick = lockedChoiceRef.current || selectedRef.current;
        // Only reject the pick if it's taken by *another* player (not the current user).
        const takenByOther = pick
          ? takenCountriesRef.current[pick] &&
            takenCountriesRef.current[pick].userId !== userId
          : true;
        if (!pick || takenByOther) {
          const taken = takenCountriesRef.current;
          const candidates = features
            .map((f) => f.id as string)
            .filter((id) => !taken[id] || taken[id].userId === userId);
          pick = candidates[Math.floor(Math.random() * candidates.length)];
        }
        if (pick) {
          (async () => {
            if (lobbyId && userId) {
              await supabase.from("lobby_players")
                .update({ country_id: pick })
                .eq("lobby_id", lobbyId).eq("user_id", userId);
            }
            onConfirm(pick!);
          })();
        }
      }
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [selectionEndsAt, features, lobbyId, userId, onConfirm]);

  // Watch other lobby players' chosen countries
  useEffect(() => {
    if (!lobbyId) return;
    const fetchTaken = async () => {
      const { data } = await supabase
        .from("lobby_players")
        .select("country_id, display_name, user_id")
        .eq("lobby_id", lobbyId)
        .not("country_id", "is", null);
      const map: Record<string, { name: string; userId: string }> = {};
      (data || []).forEach((r: any) => {
        if (r.country_id) map[r.country_id] = { name: r.display_name, userId: r.user_id };
      });
      takenCountriesRef.current = map;
      setTakenCountries(map);
    };
    fetchTaken();
    const ch = supabase
      .channel(`select-${lobbyId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "lobby_players", filter: `lobby_id=eq.${lobbyId}` }, fetchTaken)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [lobbyId]);

  useEffect(() => {
    fetch("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json")
      .then((r) => r.json())
      .then((topo: Topology) => {
        const geo = feature(topo, topo.objects.countries as GeometryCollection) as unknown as FeatureCollection;
        setFeatures(geo.features.filter((f) => !EXCLUDED.includes(f.id as string)));
      });
  }, []);

  useEffect(() => {
    if (!svgRef.current || features.length === 0) return;
    const svg = d3.select(svgRef.current);
    const w = window.innerWidth;
    const h = window.innerHeight;

    const projection = d3.geoNaturalEarth1().fitSize([w, h], { type: "FeatureCollection", features });
    const path = d3.geoPath(projection);

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([1, 8])
      .on("zoom", (e) => {
        svg.select<SVGGElement>("g.map-group").attr("transform", e.transform.toString());
      });
    zoomRef.current = zoom;
    svg.call(zoom);

    const g = svg.select<SVGGElement>("g.map-group");
    g.selectAll("path.country")
      .data(features, (d: any) => d.id)
      .join("path")
      .attr("class", "country")
      .attr("d", (d) => path(d) || "")
      .attr("data-id", (d) => d.id as string)
      .attr("fill", "#2d3b2d")
      .attr("stroke", "#4a5568")
      .attr("stroke-width", 0.5)
      .style("cursor", "pointer");
  }, [features]);

  // Search highlight
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    if (search.trim()) {
      const lower = search.toLowerCase();
      const matchId = features.find((f) =>
        getCountryName(f.id as string).toLowerCase().includes(lower)
      )?.id as string | undefined;

      if (matchId) {
        // Zoom to the matched country
        const el = svg.select(`path[data-id="${matchId}"]`);
        if (!el.empty()) {
          el.attr("fill", "#f97316");
          setHovered(matchId);
        }
      }
    }
  }, [search, features]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const target = (e.target as SVGElement).closest("path.country");
      if (target) {
        const id = target.getAttribute("data-id") || "";
        if (id !== hovered) {
          setHovered(id);
          setTooltip({ x: e.clientX, y: e.clientY, name: getCountryName(id) });
        } else {
          setTooltip((p) => (p ? { ...p, x: e.clientX, y: e.clientY } : null));
        }
      } else {
        setHovered(null);
        setTooltip(null);
      }
    },
    [hovered]
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = (e.target as SVGElement).closest("path.country");
      if (target) {
        const id = target.getAttribute("data-id") || "";
        setSelected(id);
      }
    },
    []
  );

  // Update fills for hover/select
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll<SVGPathElement, Feature>("path.country").attr("fill", (d) => {
      const id = d.id as string;
      if (id === lockedChoice) return "#16a34a";
      if (id === selected) return "#7c3aed";
      if (id === hovered) return "#f97316";
      if (takenCountries[id]) return "#dc2626";
      return "#2d3b2d";
    });
  }, [hovered, selected, takenCountries, lockedChoice]);

  const selectedCountry = selected ? getCountryName(selected) : null;
  const selectedFlag = selected ? getCountryFlag(selected) : "";
  const selectedTakenByObj = selected ? takenCountries[selected] : null;
  const selectedTakenByOther = selectedTakenByObj && selectedTakenByObj.userId !== userId ? selectedTakenByObj.name : null;

  const handleConfirm = async () => {
    if (!selected) return;
    if (lobbyId) {
      if (userId) {
        await supabase.from("lobby_players")
          .update({ country_id: selected })
          .eq("lobby_id", lobbyId)
          .eq("user_id", userId);
      }
      // In a multiplayer lobby with a countdown, lock in and wait for timer.
      if (selectionEndsAt) {
        setLockedChoice(selected);
        setSelected(null);
        return;
      }
    }
    if (!hasStartedRef.current) {
      hasStartedRef.current = true;
      onConfirm(selected);
    }
  };

  return (
    <div className="relative w-full h-full">
      {/* Search bar */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20">
        <input
          type="text"
          placeholder="Search for a country..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-80 px-4 py-2 rounded-lg bg-[#0f1420]/90 text-white border border-[#4a5568] placeholder-gray-400 focus:outline-none focus:border-[#f97316] backdrop-blur-sm"
        />
      </div>

      {/* Map */}
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        className="bg-[#1a1f2e]"
        onMouseMove={handleMouseMove}
        onClick={handleClick}
      >
        <g className="map-group" />
      </svg>

      {/* Tooltip */}
      {tooltip && !selected && (
        <div
          className="fixed z-30 pointer-events-none px-3 py-1.5 rounded bg-[#0f1420]/95 text-white text-sm border border-[#4a5568] backdrop-blur-sm"
          style={{ left: tooltip.x + 12, top: tooltip.y - 10 }}
        >
          {getCountryFlag(hovered || "")} {tooltip.name}
        </div>
      )}

      {/* Selection panel */}
      {selected && selectedCountry && (
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-20 bg-[#0f1420]/95 backdrop-blur-md border border-[#4a5568] rounded-xl p-6 min-w-[320px] text-center">
          <div className="text-4xl mb-2">{selectedFlag}</div>
          <h2 className="text-2xl font-bold text-white mb-3">{selectedCountry}</h2>
          <div className="flex justify-center gap-6 mb-4 text-sm text-gray-300">
            <div>
              <div className="text-white font-bold">1,000</div>
              <div>Troops</div>
            </div>
            <div>
              <div className="text-white font-bold">500</div>
              <div>Gold</div>
            </div>
            <div>
              <div className="text-white font-bold">0</div>
              <div>Factories</div>
            </div>
          </div>
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => setSelected(null)}
              className="px-4 py-2 rounded-lg bg-[#2d3b2d] text-gray-300 hover:bg-[#3d4b3d] transition"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={!!selectedTakenByOther}
              className="px-6 py-2 rounded-lg bg-[#f97316] text-white font-bold hover:bg-[#ea580c] transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {selectedTakenByOther ? `Taken by ${selectedTakenByOther}` : selectionEndsAt ? `Lock in ${selectedCountry}` : `Play as ${selectedCountry}`}
            </button>
          </div>
        </div>
      )}

      {/* Title */}
      <div className="absolute top-4 left-4 z-20">
        <h1 className="text-2xl font-bold text-white/80">Select Your Nation</h1>
        {selectionEndsAt && timeLeft !== null && (
          <div className="mt-2 text-sm">
            <span className={`font-mono font-bold ${timeLeft <= 5 ? "text-red-400" : "text-[#f97316]"}`}>
              {timeLeft}s
            </span>
            <span className="text-gray-300 ml-2">to choose</span>
            {lockedChoice && (
              <div className="mt-1 text-xs text-emerald-400">
                Locked in: {getCountryFlag(lockedChoice)} {getCountryName(lockedChoice)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
            }
