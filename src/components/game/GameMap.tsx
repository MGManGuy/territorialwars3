import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import * as d3 from "d3";
import { feature, neighbors as topoNeighbors } from "topojson-client";
type Topology = any; type GeometryCollection = any;
import type { FeatureCollection, Feature, Geometry } from "geojson";
import { getCountryName, getCountryFlag } from "@/game/countryNames";
import { initGameState, getGoldRate, getTroopRate, getLeaderboard, getPoliticalPowerRate } from "@/game/gameState";
import {
  type GameState, type BuildingType, type War, BUILDING_DEFS, BUILDING_SLOTS,
  advanceDate, formatDate, PLAYER_COLOR, RESEARCH_DEFS, GOALS, CONTINENTS, CONTINENT_NAMES, FORMABLES,
} from "@/game/types";

// ─── Building dot colors (replaces emoji SVG text — massive perf win) ────────
const BUILDING_COLORS: Record<BuildingType, string> = {
  city:       "#facc15",
  factory:    "#ef4444",
  port:       "#38bdf8",
  fort:       "#94a3b8",
  barracks:   "#4ade80",
  courthouse: "#2dd4bf",
  airbase:    "#a78bfa",
};

// ─── Province System ──────────────────────────────────────────────────────────
interface Province {
  id: string;
  name: string;
  stationPercent: number;
  isCapital: boolean;
  isFallen: boolean;
  terrainBonus: number;
  terrainLabel: string;
  population: number; // relative pop — affects gold and troop output
}

const TERRAIN_TYPES = [
  { label: "Plains",    bonus: 0.00, color: "#8BC34A" },
  { label: "Hills",     bonus: 0.10, color: "#A5956A" },
  { label: "Forest",    bonus: 0.15, color: "#388E3C" },
  { label: "Mountains", bonus: 0.28, color: "#607D8B" },
  { label: "Desert",    bonus: 0.05, color: "#DEB887" },
  { label: "Coastal",   bonus: 0.05, color: "#4FC3F7" },
  { label: "Jungle",    bonus: 0.20, color: "#2E7D32" },
  { label: "Steppe",    bonus: 0.03, color: "#9E9D24" },
];

const PROVINCE_SUFFIX = [
  "Northern Province", "Southern Region", "Eastern Territory",
  "Western Frontier", "Highland Region", "Coastal Zone",
  "Valley Province", "Central Plains", "Border Territory",
  "Forest Region", "Desert Province", "River Delta",
  "Interior Zone", "Bay Province", "Lowlands",
];

function generateProvinces(countryId: string, countryName: string): Province[] {
  const h = Array.from(countryId).reduce((a, c) => a * 31 + c.charCodeAt(0), 0) >>> 0;
  const count = 3 + (h % 3); // 3-5 provinces

  const capitalPct = 40;
  const otherBase  = Math.floor((100 - capitalPct) / (count - 1));
  const leftover   = 100 - capitalPct - otherBase * (count - 1);

  const provinces: Province[] = [];
  for (let i = 0; i < count; i++) {
    const terrainIdx  = ((h >> (i * 3)) & 0x7) % TERRAIN_TYPES.length;
    const terrain     = TERRAIN_TYPES[terrainIdx];
    const suffixIdx   = ((h >> (i + 4)) & 0xf) % PROVINCE_SUFFIX.length;
    const pop         = i === 0 ? 100 : 30 + ((h >> (i * 5)) & 0x3f);

    provinces.push({
      id:             `${countryId}-p${i}`,
      name:           i === 0 ? `${countryName} (Capital)` : `${PROVINCE_SUFFIX[suffixIdx]}`,
      stationPercent: i === 0 ? capitalPct : i === 1 ? otherBase + leftover : otherBase,
      isCapital:      i === 0,
      isFallen:       false,
      terrainBonus:   terrain.bonus,
      terrainLabel:   terrain.label,
      population:     pop,
    });
  }
  return provinces;
}

function getFrontProvince(provinces: Province[]): Province | null {
  const active = provinces.filter(p => !p.isFallen);
  if (!active.length) return null;
  const nonCapitals = active.filter(p => !p.isCapital);
  if (nonCapitals.length) return nonCapitals.reduce((a, b) => a.stationPercent < b.stationPercent ? a : b);
  return active.find(p => p.isCapital) ?? null;
}

// ─── War helpers ──────────────────────────────────────────────────────────────
function isAtWar(wars: War[], countryId: string): boolean {
  return wars.some(w => w.countryId === countryId);
}
function removeWar(wars: War[], countryId: string): War[] {
  return wars.filter(w => w.countryId !== countryId);
}

// ─── Naval invasion helper ────────────────────────────────────────────────────
function getNavalCap(gameState: GameState): number {
  return Object.values(gameState.countries)
    .filter(c => c.owner === "player")
    .reduce((s, c) => s + c.buildings.filter(b => b.type === "port").length, 0) * 1000;
}

function canReach(
  attackTarget: string,
  gameState: GameState,
  neighborsRef: React.MutableRefObject<Record<string, Set<string>>>
): { ok: boolean; naval: boolean; navalCap: number; reason?: string } {
  const playerOwned = new Set(
    Object.values(gameState.countries).filter(c => c.owner === "player").map(c => c.id)
  );
  const nbs = neighborsRef.current[attackTarget] || new Set<string>();
  const hasBorder = [...nbs].some(n => playerOwned.has(n));
  if (hasBorder) return { ok: true, naval: false, navalCap: 0 };

  const tc = gameState.countries[attackTarget];
  if (!tc?.isCoastal) return { ok: false, naval: false, navalCap: 0, reason: "No land border & target is landlocked" };

  const cap = getNavalCap(gameState);
  if (cap === 0) return { ok: false, naval: true, navalCap: 0, reason: "Need at least 1 Port for naval invasion" };

  return { ok: true, naval: true, navalCap: cap };
}

// ─── Props ────────────────────────────────────────────────────────────────────
interface Props {
  playerCountryId: string;
  difficulty?: "easy" | "normal" | "hard";
  lobbyId?: string | null;
  onExit: () => void;
}

const EXCLUDED = ["010"];

const COUNTRY_ECON_MULT: Record<string, number> = {
  "840": 9.5, "156": 9.5, "356": 8.0, "076": 6.5, "643": 8.0,
  "250": 4.0, "826": 4.0, "586": 3.5, "682": 4.0, "124": 4.0, "276": 4.2,
};

function variance(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return 0.7 + ((h % 1000) / 1000) * 0.55;
}
function effectiveMult(id: string): number {
  if (COUNTRY_ECON_MULT[id] != null) {
    const j = 0.95 + ((Array.from(id).reduce((a, c) => a + c.charCodeAt(0), 0) % 100) / 1000);
    return COUNTRY_ECON_MULT[id] * j;
  }
  return variance(id);
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function GameMap({ playerCountryId, difficulty = "easy", lobbyId, onExit }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [features,           setFeatures]           = useState<Feature<Geometry>[]>([]);
  const [gameState,          setGameState]          = useState<GameState | null>(null);
  const [selectedBuilding,   setSelectedBuilding]   = useState<BuildingType | null>(null);
  const [contextMenu,        setContextMenu]        = useState<{ x: number; y: number; countryId: string } | null>(null);
  const [inspecting,         setInspecting]         = useState<string | null>(null);
  const [notification,       setNotification]       = useState<string | null>(null);
  const [showAdvisor,        setShowAdvisor]        = useState(false);
  const [advisorMessages,    setAdvisorMessages]    = useState<{ role: string; content: string }[]>([]);
  const [advisorInput,       setAdvisorInput]       = useState("");
  const [advisorLoading,     setAdvisorLoading]     = useState(false);
  const [showFullLeaderboard,setShowFullLeaderboard]= useState(false);
  const [lastTroopRequestYear,setLastTroopRequestYear] = useState(0);
  const [showResearch,       setShowResearch]       = useState(false);
  const [showGoals,          setShowGoals]          = useState(false);
  const [showNotifLog,       setShowNotifLog]       = useState(false);
  const [showFormables,      setShowFormables]      = useState(false);
  const [buildMultiplier,    setBuildMultiplier]    = useState<1 | 5 | 10>(1);
  const [hoveredCountry,     setHoveredCountry]     = useState<string | null>(null);

  // Attack / battle
  const [attackTarget,  setAttackTarget]  = useState<string | null>(null);
  const [attackTroops,  setAttackTroops]  = useState(0);
  const [attackTanks,   setAttackTanks]   = useState(0);
  const [attackPlanes,  setAttackPlanes]  = useState(0);
  const [battle,        setBattle]        = useState<{
    targetId: string;
    provinceId: string;
    isCapitalBattle: boolean;
    attacker: number;
    defender: number;
    attackerPlanes: number;
    defenderPlanes: number;
    attackerTanks: number;
    progress: number;
    defenseMult: number;
    forceAttackUntil?: number;
    lastStandUntil?: number;
    aiLastStandUntil?: number;
    aiLastStandUsed?: boolean;
    initialDefender?: number;
  } | null>(null);
  const [defenderBattle, setDefenderBattle] = useState<{
    targetId: string; attackerKey: string; attackerName: string;
    attacker: number; defender: number; attackerTanks: number;
    attackerPlanes: number; defenderPlanes: number;
    progress: number; defenseMult: number;
    forceAttackUntil?: number; lastStandUntil?: number; updatedAt: number;
  } | null>(null);

  // Province state
  const [allProvinces,      setAllProvinces]      = useState<Record<string, Province[]>>({});
  const [showProvincePanel, setShowProvincePanel] = useState<string | null>(null);
  const allProvincesRef = useRef<Record<string, Province[]>>({});
  useEffect(() => { allProvincesRef.current = allProvinces; }, [allProvinces]);

  // Multiplayer refs
  const gameStateRef       = useRef<GameState | null>(null);
  const featuresRef        = useRef<Feature<Geometry>[]>([]);
  const neighborsRef       = useRef<Record<string, Set<string>>>({});
  const myUserIdRef        = useRef<string | null>(null);
  const myOwnerKeyRef      = useRef<string>("player");
  const myNameRef          = useRef<string>("Player");
  const myColorRef         = useRef<string>(PLAYER_COLOR);
  const mpChannelRef       = useRef<{ broadcast: (e: any) => void; leave: () => void } | null>(null);
  const humanByOwnerKeyRef = useRef<Record<string, { name: string; color: string }>>({});

  const mpBroadcast = useCallback((event: any) => { mpChannelRef.current?.broadcast(event); }, []);
  const ownerIn = useCallback((o: string | null) => (!o ? null : o === myOwnerKeyRef.current ? "player" : o), []);

  // ── Game init ────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let reservedOwners: Record<string, { id: string; name: string; color: string }> | undefined;
      let seed: string | undefined;

      if (lobbyId) {
        seed = lobbyId;
        const { supabase } = await import("@/integrations/supabase/client");
        const { data: userData } = await supabase.auth.getUser();
        const uid = userData.user?.id || null;
        myUserIdRef.current = uid;
        if (uid) myOwnerKeyRef.current = `human-${uid}`;
        const { data } = await supabase
          .from("lobby_players")
          .select("user_id, display_name, color, country_id")
          .eq("lobby_id", lobbyId)
          .not("country_id", "is", null);
        reservedOwners = {};
        const humanMap: Record<string, { name: string; color: string }> = {};
        (data || []).forEach((p: any) => {
          const key = `human-${p.user_id}`;
          humanMap[key] = { name: p.display_name, color: p.color };
          if (p.user_id === uid) {
            myNameRef.current  = p.display_name;
            myColorRef.current = p.color;
          } else if (p.country_id && p.country_id !== playerCountryId) {
            reservedOwners![p.country_id] = { id: key, name: p.display_name, color: p.color };
          }
        });
        humanByOwnerKeyRef.current = humanMap;
      }

      const topo: Topology = await fetch(
        "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json"
      ).then(r => r.json());
      if (cancelled) return;

      const geo   = feature(topo, topo.objects.countries as GeometryCollection) as unknown as FeatureCollection;
      const feats = geo.features.filter(f => !EXCLUDED.includes(f.id as string));
      setFeatures(feats);
      featuresRef.current = feats;
      const allIds = feats.map(f => f.id as string);

      const allObjects = (topo.objects.countries as any).geometries;
      const nbArrays   = topoNeighbors(allObjects);
      const nbMap: Record<string, Set<string>> = {};
      allObjects.forEach((obj: any, i: number) => {
        const id = obj.id as string;
        if (!id) return;
        nbMap[id] = new Set(nbArrays[i].map((j: number) => allObjects[j].id).filter(Boolean));
      });
      neighborsRef.current = nbMap;

      const gs = initGameState(playerCountryId, allIds, allIds.length, { seed, reservedOwners });

      const LANDLOCKED = new Set([
        "040","051","031","064","068","112","072","854","108","140","148","203","268","348",
        "398","417","418","442","426","454","466","478","496","524","562","620","646","686",
        "688","705","703","728","748","762","795","800","860","807","716","894","499",
      ]);
      for (const id of allIds) {
        if (gs.countries[id]) gs.countries[id].isCoastal = !LANDLOCKED.has(id);
      }

      setGameState(gs);
      gameStateRef.current = gs;

      const provinceMap: Record<string, Province[]> = {};
      for (const id of allIds) {
        const c = gs.countries[id];
        if (c) provinceMap[id] = generateProvinces(id, c.name);
      }
      setAllProvinces(provinceMap);
      allProvincesRef.current = provinceMap;
    })();
    return () => { cancelled = true; };
  }, [playerCountryId, difficulty, lobbyId]);

  // ── Multiplayer channel ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!lobbyId) return;
    let cancelled = false;
    (async () => {
      const { joinLobbyChannel } = await import("@/game/multiplayerSync");
      if (cancelled) return;
      const ch = joinLobbyChannel(lobbyId, (event) => {
        const ev = event as any;
        const fromLocal     = ownerIn(ev.from);
        const toLocal       = ev.to ? ownerIn(ev.to) : null;
        const newOwnerLocal = ev.newOwner ? ownerIn(ev.newOwner) : null;
        const fromInfo      = humanByOwnerKeyRef.current[ev.from];
        const fromName      = ev.fromName || fromInfo?.name || "Another player";

        if (ev.type === "build") {
          setGameState(prev => {
            if (!prev) return prev;
            const c = prev.countries[ev.countryId];
            if (!c) return prev;
            return { ...prev, countries: { ...prev.countries, [ev.countryId]: { ...c, buildings: [...c.buildings, ev.building] } } };
          });
        } else if (ev.type === "war_declared" && toLocal === "player") {
          setGameState(prev => {
            if (!prev) return prev;
            const attackerCountries = Object.values(prev.countries).filter(c => c.owner === ev.from);
            const existing = new Set(prev.wars.map(w => w.countryId));
            const newWars  = [...prev.wars];
            for (const c of attackerCountries) if (!existing.has(c.id)) newWars.push({ countryId: c.id, startedAt: Date.now() });
            return { ...prev, wars: newWars };
          });
          showNotif(`⚔ ${fromName} DECLARED WAR on you!`);
        } else if (ev.type === "war_ended" && toLocal === "player") {
          setGameState(prev => {
            if (!prev) return prev;
            const attackerCountries = new Set(Object.values(prev.countries).filter(c => c.owner === ev.from).map(c => c.id));
            return { ...prev, wars: prev.wars.filter(w => !attackerCountries.has(w.countryId)) };
          });
          showNotif(`🕊 ${fromName} made peace.`);
        } else if (ev.type === "attack_started") {
          setGameState(prev => {
            if (prev?.countries[ev.targetCountryId]?.owner === "player") {
              showNotif(`⚠ ${fromName} is ATTACKING ${prev.countries[ev.targetCountryId].name} with ${ev.troops} troops!`);
            }
            return prev;
          });
        } else if (ev.type === "country_captured") {
          setGameState(prev => {
            if (!prev) return prev;
            const c  = prev.countries[ev.countryId];
            if (!c)  return prev;
            const wasMine  = c.owner === "player";
            const newOwner = newOwnerLocal!;
            const next     = { ...c, owner: newOwner, color: newOwner === "player" ? PLAYER_COLOR : ev.newOwnerColor, troops: ev.troopsLeft };
            if (wasMine) showNotif(`💀 Lost ${c.name} to ${fromName}!`);
            return { ...prev, countries: { ...prev.countries, [ev.countryId]: next }, wars: prev.wars.filter(w => w.countryId !== ev.countryId) };
          });
          setDefenderBattle(db => (db?.targetId === ev.countryId ? null : db));
        } else if (ev.type === "battle_state") {
          const cs = gameStateRef.current;
          if (!cs?.countries[ev.targetCountryId] || cs.countries[ev.targetCountryId].owner !== "player") return;
          setDefenderBattle({
            targetId: ev.targetCountryId, attackerKey: ev.from, attackerName: ev.fromName,
            attacker: ev.attacker, defender: ev.defender, attackerTanks: ev.attackerTanks,
            attackerPlanes: ev.attackerPlanes, defenderPlanes: ev.defenderPlanes,
            progress: ev.progress, defenseMult: ev.defenseMult,
            forceAttackUntil: ev.forceAttackUntil, lastStandUntil: ev.defenderLastStandUntil,
            updatedAt: Date.now(),
          });
        } else if (ev.type === "battle_ended") {
          setDefenderBattle(db => (db?.targetId === ev.targetCountryId ? null : db));
        } else if (ev.type === "defender_last_stand") {
          setBattle(b => b?.targetId === ev.targetCountryId ? { ...b, aiLastStandUntil: ev.until, aiLastStandUsed: true } : b);
        }
      });
      mpChannelRef.current = ch;
    })();
    return () => { cancelled = true; mpChannelRef.current?.leave(); mpChannelRef.current = null; };
  }, [lobbyId, ownerIn]);

  // ── Map fill updater ─────────────────────────────────────────────────────────
  const updateFills = useCallback((gs: GameState) => {
    if (!svgRef.current) return;
    d3.select(svgRef.current)
      .selectAll<SVGPathElement, Feature>("path.country")
      .attr("fill", d => {
        const c = gs.countries[d.id as string];
        if (!c) return "#2d3b2d";
        // Shade fallen-province countries slightly darker
        const hasFallen = (allProvincesRef.current[d.id as string] || []).some(p => p.isFallen);
        const base = c.owner ? c.color + "cc" : c.color || "#5a6b5a";
        return hasFallen ? (c.color || "#5a6b5a") + "99" : base;
      })
      .attr("stroke", d => {
        const id = d.id as string;
        if (id === gs.playerCountryId) return "#a78bfa";
        const c = gs.countries[id];
        if (c?.owner && gs.alliances.includes(c.owner)) return "#22d3ee";
        return "#4a5568";
      })
      .attr("stroke-width", d => {
        const id = d.id as string;
        if (id === gs.playerCountryId) return 1.5;
        const c = gs.countries[id];
        if (c?.owner && gs.alliances.includes(c.owner)) return 1.5;
        return 0.5;
      });
  }, []);

  // ── Initial map draw — runs once when features load ──────────────────────────
  useEffect(() => {
    if (!svgRef.current || !features.length || !gameState) return;
    const svg = d3.select(svgRef.current);
    const w   = window.innerWidth;
    const h   = window.innerHeight;
    const projection = d3.geoNaturalEarth1().fitSize([w, h], { type: "FeatureCollection", features });
    const path        = d3.geoPath(projection);

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([1, 8])
      .on("zoom", e => svg.select<SVGGElement>("g.map-group").attr("transform", e.transform.toString()));
    svg.call(zoom);
    (svgRef.current as any).__zoomBehavior = zoom;
    (svgRef.current as any).__projection   = projection;
    (svgRef.current as any).__path         = path;

    const g = svg.select<SVGGElement>("g.map-group");

    g.selectAll("path.country")
      .data(features, (d: any) => d.id)
      .join("path")
      .attr("class",   "country")
      .attr("d",       d => path(d) || "")
      .attr("data-id", d => d.id as string);

    updateFills(gameState);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [features]); // only on first feature load

  // ── Building dots + fill refresh — runs when gameState changes ────────────────
  // Uses colored circles instead of emoji SVG text → ~10× faster
  useEffect(() => {
    if (!svgRef.current || !features.length || !gameState) return;
    const svg  = d3.select(svgRef.current);
    const g    = svg.select<SVGGElement>("g.map-group");
    const path = (svgRef.current as any).__path as d3.GeoPath | undefined;
    if (!path) return;

    // Building dots
    const allDots: Array<{ key: string; x: number; y: number; color: string; title: string }> = [];
    for (const f of features) {
      const c = gameState.countries[f.id as string];
      if (!c || !c.buildings.length) continue;
      const centroid = path.centroid(f);
      if (!isFinite(centroid[0]) || !isFinite(centroid[1])) continue;
      c.buildings.forEach((b, i) => {
        const angle  = (i / Math.max(1, c.buildings.length)) * Math.PI * 2;
        const radius = 4 + Math.floor(i / 8) * 6;
        allDots.push({
          key:   `${f.id}-${i}`,
          x:     b.x ?? centroid[0] + Math.cos(angle) * radius,
          y:     b.y ?? centroid[1] + Math.sin(angle) * radius,
          color: BUILDING_COLORS[b.type] ?? "#ffffff",
          title: b.type,
        });
      });
    }

    g.selectAll<SVGCircleElement, typeof allDots[0]>("circle.building-dot")
      .data(allDots, d => d.key)
      .join("circle")
      .attr("class",         "building-dot")
      .attr("r",             3)
      .attr("cx",            d => d.x)
      .attr("cy",            d => d.y)
      .attr("fill",          d => d.color)
      .attr("stroke",        "#000")
      .attr("stroke-width",  0.4)
      .attr("pointer-events","none");

    // Province fallen markers — small red X on fallen-province countries
    const fallenMarkers: Array<{ key: string; x: number; y: number }> = [];
    for (const f of features) {
      const provs = allProvinces[f.id as string] || [];
      const fallenCount = provs.filter(p => p.isFallen).length;
      if (fallenCount === 0) continue;
      const centroid = path.centroid(f);
      if (!isFinite(centroid[0]) || !isFinite(centroid[1])) continue;
      for (let i = 0; i < fallenCount; i++) {
        fallenMarkers.push({ key: `${f.id}-fallen-${i}`, x: centroid[0] + i * 7, y: centroid[1] - 6 });
      }
    }

    g.selectAll<SVGTextElement, typeof fallenMarkers[0]>("text.fallen-marker")
      .data(fallenMarkers, d => d.key)
      .join("text")
      .attr("class",              "fallen-marker")
      .attr("x",                  d => d.x)
      .attr("y",                  d => d.y)
      .attr("text-anchor",        "middle")
      .attr("dominant-baseline",  "central")
      .attr("font-size",          "8px")
      .attr("fill",               "#ef4444")
      .attr("pointer-events",     "none")
      .text("✕");

    updateFills(gameState);
  }, [gameState, features, allProvinces, updateFills]);

  // ── Economy tick — 500ms (5× less CPU, same game speed) ─────────────────────
  useEffect(() => {
    if (!gameState) return;
    const interval = setInterval(() => {
      setGameState(prev => {
        if (!prev || prev.paused) return prev;
        // Advance 5 days per tick instead of 1 — same gameplay speed, 5× fewer re-renders
        const newDate   = advanceDate(prev.date, prev.speed * 5);
        const now       = Date.now();
        const newCountries = { ...prev.countries };
        let playerGoldBonusFromTrade = 0;
        let playerTanksGain  = 0;
        let playerPlanesGain = 0;
        let playerCourthousePP = 0;

        const aiBuff     = difficulty === "hard" ? 1.5 : difficulty === "normal" ? 1.25 : 1.0;
        const playerNerf = difficulty === "hard" ? 0.5 : difficulty === "normal" ? 0.75 : 1.0;

        for (const cid in newCountries) {
          const c      = newCountries[cid];
          const isBot  = c.owner && c.owner !== "player";
          const mult   = effectiveMult(cid) * (isBot ? aiBuff : playerNerf) * 5; // ×5 to match 500ms tick

          const cityCount       = c.buildings.filter(b => b.type === "city").length;
          const barracksCount   = c.buildings.filter(b => b.type === "barracks").length;
          const factoryCount    = c.buildings.filter(b => b.type === "factory").length;
          const courthouseCount = c.buildings.filter(b => b.type === "courthouse").length;
          const airbaseCount    = c.buildings.filter(b => b.type === "airbase").length;

          const goldGain   = (0.1 + cityCount * 0.05) * mult;
          const troopGain  = (0.2 + barracksCount * 0.02) * mult;
          const tankGain   = factoryCount * 0.1 * (isBot ? aiBuff : playerNerf) * 5;
          const planeGain  = airbaseCount * 0.1 * (isBot ? aiBuff : playerNerf) * 5;
          const airUpkeep  = airbaseCount * 0.2 * 5;
          const tradeBonus = c.tradeDeals.length * 0.2 * 5;
          if (c.tradeDeals.includes("player") && c.owner !== "player") playerGoldBonusFromTrade += 0.2 * 5;

          let newGold      = Math.max(0, c.gold + goldGain + tradeBonus - airUpkeep);
          let newBuildings = c.buildings;

          let newRelations     = c.relations;
          let newDiplomatUntil = c.diplomatUntil;
          if (c.diplomatUntil && now < c.diplomatUntil) {
            newRelations = { ...c.relations, player: (c.relations.player || 0) + 0.1 * 5 };
          }
          if (c.diplomatUntil && now >= c.diplomatUntil) newDiplomatUntil = undefined;

          // AI building
          if (c.owner && c.owner !== "player" && !c.owner.startsWith("human-")) {
            const totalBuilt  = c.buildings.length;
            const fortCount   = c.buildings.filter(b => b.type === "fort").length;
            const portCount   = c.buildings.filter(b => b.type === "port").length;
            const isRichMajor = !!(COUNTRY_ECON_MULT[cid] && COUNTRY_ECON_MULT[cid] >= 3.0);
            const isIsland    = c.isCoastal !== false && (!(neighborsRef.current[cid]) || neighborsRef.current[cid].size === 0);
            const isTargeted  = prev.wars.some(w => w.countryId === cid);

            let nextType: BuildingType = "city";
            if (isTargeted && fortCount < 5)                           nextType = "fort";
            else if (cityCount < (isRichMajor ? 8 : 5))               nextType = "city";
            else if (barracksCount < (isRichMajor ? 4 : 3))           nextType = "barracks";
            else if (factoryCount < (isRichMajor ? 3 : 2))            nextType = "factory";
            else if (courthouseCount < 1)                              nextType = "courthouse";
            else if (totalBuilt >= (isRichMajor ? 5 : 10) && airbaseCount < (isRichMajor ? 4 : 1)) nextType = "airbase";
            else if (isIsland && portCount < 1)                        nextType = "port";
            else                                                        nextType = "city";

            const def = BUILDING_DEFS[nextType];
            if (newGold >= def.cost && totalBuilt < 25) {
              newGold     -= def.cost;
              newBuildings = [...newBuildings, { type: nextType, icon: def.icon }];
            }
          }

          if (c.owner === "player") {
            playerTanksGain    += tankGain;
            playerPlanesGain   += planeGain;
            playerCourthousePP += courthouseCount * 0.05 * 5;
          }

          newCountries[cid] = {
            ...c, gold: newGold, troops: c.troops + troopGain,
            tanks: c.tanks + tankGain, planes: c.planes + planeGain,
            buildings: newBuildings, relations: newRelations, diplomatUntil: newDiplomatUntil,
          };
        }

        const goldRate  = getGoldRate(prev);
        const troopRate = getTroopRate(prev);
        const ppRate    = getPoliticalPowerRate(prev);
        const goldMult  = 1 + ((prev.researchLevels?.gold  || 0) * 0.1);
        const troopMult = 1 + ((prev.researchLevels?.troop || 0) * 0.1);

        let researchLevels = { ...(prev.researchLevels || {}) };
        let activeResearch  = prev.activeResearch;
        if (activeResearch) {
          const def = RESEARCH_DEFS.find(r => r.id === activeResearch!.id);
          if (def && now - activeResearch.startedAt >= def.durationMs) {
            researchLevels[activeResearch.id] = (researchLevels[activeResearch.id] || 0) + 1;
            setTimeout(() => showNotif(`✅ ${def.label} Lv${researchLevels[def.id]} complete!`), 0);
            activeResearch = null;
          }
        }

        let completedGoals = prev.completedGoals;
        let goalReward     = 0;
        const ownedCount   = Object.values(prev.countries).filter(c => c.owner === "player").length;
        const startContinent = CONTINENTS[prev.playerCountryId];
        for (const goal of GOALS) {
          if (completedGoals.includes(goal.id)) continue;
          let achieved = false;
          if (goal.id === "continent" && startContinent) {
            const inCont = Object.keys(CONTINENTS).filter(id => CONTINENTS[id] === startContinent && prev.countries[id]);
            achieved = inCont.length > 0 && inCont.every(id => prev.countries[id]?.owner === "player");
          } else if (goal.id === "ten")       achieved = ownedCount >= 10;
          else if (goal.id === "twentyfive")  achieved = ownedCount >= 25;
          if (achieved) {
            completedGoals = [...completedGoals, goal.id];
            goalReward    += goal.reward;
            setTimeout(() => showNotif(`🏆 Goal: ${goal.label}! +${goal.reward} PP`), 0);
          }
        }

        const next = {
          ...prev,
          gold:           prev.gold + ((goldRate / 10) * 5 * goldMult + playerGoldBonusFromTrade) * playerNerf,
          troops:         prev.troops + (troopRate / 10) * 5 * troopMult * playerNerf,
          tanks:          prev.tanks  + playerTanksGain,
          planes:         prev.planes + playerPlanesGain,
          politicalPower: prev.politicalPower + ((ppRate / 10) * 5 + playerCourthousePP) * playerNerf + goalReward,
          date: newDate, countries: newCountries, researchLevels, activeResearch, completedGoals,
        };
        gameStateRef.current = next;
        return next;
      });
    }, 500); // 500ms instead of 100ms
    return () => clearInterval(interval);
  }, [gameState?.paused, gameState?.speed, difficulty]);

  // ── Battle tick (250ms) with flanking + supply attrition ────────────────────
  useEffect(() => {
    if (!battle) return;
    const iv = setInterval(() => {
      setBattle(b => {
        if (!b) return b;
        const now       = Date.now();
        const isForce   = !!(b.forceAttackUntil && now < b.forceAttackUntil);
        const isLast    = !!(b.lastStandUntil   && now < b.lastStandUntil);
        let   aiLastUntil = b.aiLastStandUntil;
        let   aiLastUsed  = b.aiLastStandUsed;
        const initDef   = b.initialDefender || b.defender;

        if (!aiLastUsed && b.defender > 0 && b.defender < initDef * 0.3) {
          aiLastUntil = now + 20000; aiLastUsed = true;
          setTimeout(() => showNotif(`🛡 ${gameStateRef.current?.countries[b.targetId]?.name || "Enemy"} initiated Last Stand!`), 0);
        }
        const isAiLast = !!(aiLastUntil && now < aiLastUntil);

        let airBonusAtk = 1, airBonusDef = 1;
        if (b.attackerPlanes > b.defenderPlanes)      airBonusAtk = 1.5;
        else if (b.defenderPlanes > b.attackerPlanes) airBonusDef = 1.5;

        const rl     = gameStateRef.current?.researchLevels || {};
        const atkRes = 1 + ((rl.atk || 0) * 0.1);
        const defRes = 1 + ((rl.def || 0) * 0.1);

        const defCountry      = gameStateRef.current?.countries[b.targetId];
        const courthouseBonus = defCountry ? 1 + defCountry.buildings.filter(b2 => b2.type === "courthouse").length * 0.20 : 1;
        const prov            = allProvincesRef.current[b.targetId]?.find(p => p.id === b.provinceId);
        const terrainMlt      = prov ? 1 + prov.terrainBonus : 1;

        let defMult = b.defenseMult * defRes * airBonusDef * courthouseBonus * terrainMlt;
        if (isLast)   defMult *= 2;
        if (isAiLast) defMult *= 2;

        // ── Flanking bonus: each owned neighbor of target = +8% atk (max 3) ──
        const targetNbs  = neighborsRef.current[b.targetId] || new Set<string>();
        const flankCount = Math.min(
          [...targetNbs].filter(nid => gameStateRef.current?.countries[nid]?.owner === "player").length,
          3
        );
        const flankBonus = 1 + flankCount * 0.08;

        // ── Supply attrition: attacking with no adjacent owned territory = +15% losses ──
        const playerOwned = Object.values(gameStateRef.current?.countries ?? {}).filter(c => c.owner === "player");
        const hasSupply   = playerOwned.some(c => {
          const cnbs = neighborsRef.current[c.id] || new Set<string>();
          return cnbs.has(b.targetId);
        });
        const supplyPenalty = hasSupply ? 1.0 : 1.15;

        const atkEff   = b.attacker + b.attackerTanks * 10;
        const atkPower = (isForce ? 1.5 : 1) * atkRes * airBonusAtk * flankBonus;
        const ratio    = atkEff / Math.max(1, b.defender);

        const atkLoss  = Math.ceil(b.attacker    * 0.010 * supplyPenalty * defMult / Math.max(0.5, Math.sqrt(ratio)) * (0.8 + Math.random() * 0.4) * (isForce ? 1.2 : 1));
        const defLoss  = Math.ceil(b.defender    * 0.010 * Math.sqrt(ratio) / defMult * (0.8 + Math.random() * 0.4) * atkPower * (isLast ? 1.35 : 1));
        const tankLoss = Math.ceil(b.attackerTanks  * 0.008 * (isForce ? 1.2 : 1));
        const atkPLoss = Math.ceil(b.attackerPlanes * 0.005);
        const defPLoss = Math.ceil(b.defenderPlanes * 0.005);

        const newAtk  = Math.max(0, b.attacker       - atkLoss);
        const newDef  = Math.max(0, b.defender       - defLoss);
        const newATk  = Math.max(0, b.attackerTanks  - tankLoss);
        const newAP   = Math.max(0, b.attackerPlanes - atkPLoss);
        const newDP   = Math.max(0, b.defenderPlanes - defPLoss);
        const progress= Math.min(100, b.progress + Math.max(0.2, Math.min(3, ratio * 0.8)) * (isForce ? 1.5 : 1));
        const stale   = progress >= 100 && newAtk > 100 && newDef > 100 && Math.abs(ratio - 1) < 0.15;

        if (newAtk <= 0 || newDef <= 0 || stale) {
          setGameState(prev => {
            if (!prev) return prev;
            const target      = { ...prev.countries[b.targetId] };
            target.planes     = Math.max(0, target.planes - (b.defenderPlanes - newDP));
            const newCountries = { ...prev.countries, [b.targetId]: target };
            let newTroops     = prev.troops + newAtk;
            let newTanks      = prev.tanks  + newATk;
            let newPlanes     = prev.planes + newAP;
            let newGold       = prev.gold;
            let newWars       = prev.wars;

            if (newDef <= 0 && newAtk > 0) {
              if (!b.isCapitalBattle) {
                // Province captured — not full country
                const provPct    = (allProvincesRef.current[b.targetId]?.find(p => p.id === b.provinceId)?.stationPercent || 0) / 100;
                const troopsLost = Math.floor(target.troops * provPct);
                target.troops    = Math.max(0, target.troops - troopsLost);
                newCountries[b.targetId] = target;

                setAllProvinces(ap => {
                  const provs  = (ap[b.targetId] || []).map(p => p.id === b.provinceId ? { ...p, isFallen: true, stationPercent: 0 } : p);
                  const active = provs.filter(p => !p.isFallen);
                  const rescued = provPct * 100;
                  if (active.length > 0) {
                    const share = Math.floor(rescued / active.length);
                    return { ...ap, [b.targetId]: provs.map((p, i) => p.isFallen ? p : { ...p, stationPercent: p.stationPercent + share + (i === 0 ? rescued % active.length : 0) }) };
                  }
                  return { ...ap, [b.targetId]: provs };
                });

                setTimeout(() => {
                  const pName = allProvincesRef.current[b.targetId]?.find(p => p.id === b.provinceId)?.name || "Province";
                  showNotif(`⚔ ${pName} captured! Advance toward capital.`);
                }, 0);
              } else {
                // Capital captured — full country
                const previousOwner = target.owner;
                const looted = Math.floor(target.gold);
                newGold     += looted;
                target.gold  = 0;
                target.owner = "player";
                target.color = PLAYER_COLOR;
                target.troops = Math.max(50, Math.floor(newAtk * 0.5));
                newTroops    -= target.troops;
                newCountries[b.targetId] = target;
                newWars = removeWar(prev.wars, b.targetId);

                setAllProvinces(ap => ({
                  ...ap, [b.targetId]: generateProvinces(b.targetId, target.name),
                }));

                setTimeout(() => showNotif(`🏆 Conquered ${target.name}! Looted ${looted} gold.`), 0);
                mpBroadcast({
                  type: "country_captured", from: myOwnerKeyRef.current, fromName: myNameRef.current,
                  previousOwner: previousOwner === "player" ? myOwnerKeyRef.current : previousOwner,
                  countryId: b.targetId, newOwner: myOwnerKeyRef.current,
                  newOwnerColor: myColorRef.current, troopsLeft: target.troops,
                });
              }
            } else if (newAtk <= 0) {
              setTimeout(() => showNotif(`💀 Attack failed — your forces were destroyed.`), 0);
            } else {
              setTimeout(() => showNotif(`🛑 Stalemate — both sides withdraw.`), 0);
            }
            return { ...prev, gold: newGold, troops: Math.max(0, newTroops), tanks: Math.max(0, newTanks), planes: Math.max(0, newPlanes), countries: newCountries, wars: newWars };
          });

          const tgt = gameStateRef.current?.countries[b.targetId];
          if (tgt?.owner?.startsWith("human-")) {
            mpBroadcast({ type: "battle_ended", from: myOwnerKeyRef.current, targetCountryId: b.targetId });
          }
          return null;
        }

        const next = { ...b, attacker: newAtk, defender: newDef, attackerTanks: newATk, attackerPlanes: newAP, defenderPlanes: newDP, progress, aiLastStandUntil: aiLastUntil, aiLastStandUsed: aiLastUsed };
        const tgt2 = gameStateRef.current?.countries[b.targetId];
        if (tgt2?.owner?.startsWith("human-")) {
          mpBroadcast({
            type: "battle_state", from: myOwnerKeyRef.current, fromName: myNameRef.current,
            targetCountryId: b.targetId, attacker: next.attacker, defender: next.defender,
            attackerTanks: next.attackerTanks, attackerPlanes: next.attackerPlanes,
            defenderPlanes: next.defenderPlanes, progress: next.progress,
            defenseMult: b.defenseMult, forceAttackUntil: next.forceAttackUntil,
            defenderLastStandUntil: next.aiLastStandUntil,
          });
        }
        return next;
      });
    }, 250);
    return () => clearInterval(iv);
  }, [battle?.targetId, mpBroadcast]);

  // ── Bot counter-attack (reads ref, no re-render dependency) ─────────────────
  useEffect(() => {
    const iv = setInterval(() => {
      const prev = gameStateRef.current;
      if (!prev || prev.paused || !prev.wars.length) return;
      const now     = Date.now();
      const updates: { war: War; damage: number; enemyName: string }[] = [];
      for (const w of prev.wars) {
        if (now - w.startedAt < 60000) continue;
        if (w.lastBotAttack && now - w.lastBotAttack < 20000) continue;
        const enemy = prev.countries[w.countryId];
        if (!enemy?.owner || enemy.owner === "player" || enemy.owner.startsWith("human-")) continue;
        const damage = Math.max(20, Math.floor(enemy.troops * 0.25 * 0.25));
        updates.push({ war: w, damage, enemyName: enemy.name });
      }
      if (!updates.length) return;
      const totalLoss = updates.reduce((s, u) => s + u.damage, 0);
      setGameState(p => {
        if (!p) return p;
        return {
          ...p,
          troops: Math.max(0, p.troops - totalLoss),
          wars: p.wars.map(w => {
            const u = updates.find(x => x.war.countryId === w.countryId);
            return u ? { ...w, lastBotAttack: now } : w;
          }),
        };
      });
      for (const u of updates) showNotif(`⚠️ ${u.enemyName} counter-attacks! −${u.damage} troops!`);
    }, 2000);
    return () => clearInterval(iv);
  }, []);

  // ── Bot research + AI wars + trade offers ────────────────────────────────────
  useEffect(() => {
    const iv = setInterval(() => {
      const prev = gameStateRef.current;
      if (!prev || prev.paused) return;
      const now   = Date.now();
      const nbMap = neighborsRef.current;
      setGameState(p => {
        if (!p) return p;
        let countries  = { ...p.countries };
        let botResearch= { ...(p.botResearch || {}) };
        let botSavings = { ...(p.botSavings  || {}) };
        let wars       = p.wars;
        const notifs: string[] = [];

        for (const bot of p.bots) {
          const owned = Object.values(countries).filter(c => c.owner === bot.id);
          if (!owned.length || p.date.year < 2026) continue;
          const richest = owned.reduce((a, b) => a.gold > b.gold ? a : b);
          if (richest.gold > 60) {
            countries[richest.id] = { ...richest, gold: richest.gold - 5 };
            botSavings[bot.id]    = (botSavings[bot.id] || 0) + 5;
          }
          const lvls     = botResearch[bot.id] || { atk: 0, def: 0, gold: 0, troop: 0 };
          const branches = ["atk", "def", "gold", "troop"] as const;
          const target   = branches.reduce((a, b) => (lvls[a] <= lvls[b] ? a : b));
          if (lvls[target] < 5) {
            const cost = 1000 * (lvls[target] + 1);
            if ((botSavings[bot.id] || 0) >= cost) {
              botSavings[bot.id] -= cost;
              botResearch[bot.id] = { ...lvls, [target]: lvls[target] + 1 };
            }
          }
        }

        const playerContinent = CONTINENTS[p.playerCountryId];
        for (const cid in countries) {
          const c = countries[cid];
          if (!c.owner || c.owner === "player" || CONTINENTS[cid] !== playerContinent) continue;
          if (c.tradeDeals.includes("player")) continue;
          if ((c.relations.player || 0) < 30 || Math.random() >= 0.02) continue;
          countries[cid] = { ...c, tradeDeals: [...c.tradeDeals, "player"] };
          notifs.push(`💰 ${c.name} offered a trade deal!`);
        }

        if (p.date.year >= 2026) {
          for (const ag of p.bots) {
            if (Math.random() > 0.08) continue;
            const agCountries = Object.values(countries).filter(c => c.owner === ag.id);
            if (!agCountries.length) continue;
            const agTroops  = agCountries.reduce((s, c) => s + c.troops, 0);
            const agRichest = agCountries.reduce((a, b) => a.gold > b.gold ? a : b);
            if (agRichest.gold < 150) continue;
            outer: for (const c of agCountries) {
              const nbs = nbMap[c.id];
              if (!nbs) continue;
              for (const nbId of nbs) {
                const nb = countries[nbId];
                if (!nb?.owner || nb.owner === ag.id || nb.owner === "player" || nb.owner.startsWith("human-")) continue;
                const nbOwnerTroops = Object.values(countries).filter(cc => cc.owner === nb.owner).reduce((s, cc) => s + cc.troops, 0);
                if (agTroops < nbOwnerTroops * 2.0 || c.troops < nb.troops * 1.5) continue;
                const force  = Math.floor(c.troops * 0.75);
                const defMlt = 1 + nb.buildings.filter(b => b.type === "fort").length * 0.02;
                const atkPow = force * (1 + ((botResearch[ag.id]?.atk || 0) * 0.1));
                const defPow = nb.troops * defMlt * (1 + ((botResearch[nb.owner]?.def || 0) * 0.1));
                countries[agRichest.id] = { ...countries[agRichest.id], gold: agRichest.gold - 100 };
                countries[c.id]         = { ...countries[c.id], troops: Math.max(50, c.troops - Math.floor(force * 0.5)) };
                if (atkPow > defPow) {
                  const looted = Math.floor(nb.gold);
                  countries[c.id] = { ...countries[c.id], gold: countries[c.id].gold + looted };
                  countries[nbId] = { ...nb, owner: ag.id, color: ag.color, gold: 0, troops: Math.max(50, Math.floor(force * 0.3)) };
                  notifs.push(`⚔ ${ag.name} conquered ${nb.name}!`);
                  if (p.guarantees?.includes(nbId) && !wars.some(w => w.countryId === agCountries[0]?.id)) {
                    wars = [...wars, { countryId: agCountries[0].id, startedAt: now }];
                    notifs.push(`🛡 You guaranteed ${nb.name} — dragged into war!`);
                  }
                } else {
                  countries[nbId] = { ...nb, troops: Math.max(50, nb.troops - Math.floor(defPow * 0.2)) };
                  notifs.push(`🛡 ${nb.name} repelled ${ag.name}!`);
                }
                break outer;
              }
            }
          }
        }

        for (const m of notifs) setTimeout(() => showNotif(m), 0);
        return { ...p, countries, botResearch, botSavings, wars };
      });
    }, 3000);
    return () => clearInterval(iv);
  }, []);

  // ── WASD keyboard navigation ─────────────────────────────────────────────────
  useEffect(() => {
    const keys = new Set<string>();
    let frame: number;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      keys.add(e.key.toLowerCase());
      if (e.key === " ") {
        e.preventDefault();
        setGameState(p => p ? { ...p, paused: !p.paused } : p);
      }
      const num = parseInt(e.key);
      if (!isNaN(num) && num >= 1 && num <= BUILDING_SLOTS.length)
        setSelectedBuilding(prev => prev === BUILDING_SLOTS[num - 1] ? null : BUILDING_SLOTS[num - 1]);
      if (e.key === "Escape") {
        setSelectedBuilding(null); setContextMenu(null); setInspecting(null); setShowProvincePanel(null);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase());
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup",   onKeyUp);

    const loop = () => {
      if (svgRef.current) {
        const zoom = (svgRef.current as any).__zoomBehavior as d3.ZoomBehavior<SVGSVGElement, unknown> | undefined;
        if (zoom) {
          const speed = keys.has("shift") ? 36 : 12;
          let dx = 0, dy = 0;
          if (keys.has("w") || keys.has("arrowup"))    dy =  speed;
          if (keys.has("s") || keys.has("arrowdown"))  dy = -speed;
          if (keys.has("a") || keys.has("arrowleft"))  dx =  speed;
          if (keys.has("d") || keys.has("arrowright")) dx = -speed;
          if (dx || dy) d3.select(svgRef.current).call(zoom.translateBy, dx, dy);
        }
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup",   onKeyUp);
      cancelAnimationFrame(frame);
    };
  }, []);

  // ── Notification helper ──────────────────────────────────────────────────────
  const notifTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotif = useCallback((msg: string) => {
    setNotification(msg);
    if (notifTimer.current) clearTimeout(notifTimer.current);
    notifTimer.current = setTimeout(() => setNotification(null), 2500);
    setGameState(prev => {
      if (!prev) return prev;
      const entry = { id: Date.now() + Math.random(), message: msg, timestamp: Date.now() };
      return { ...prev, notifications: [entry, ...prev.notifications].slice(0, 100) };
    });
  }, []);

  // ── Click handler ─────────────────────────────────────────────────────────────
  const handleClick = useCallback((e: React.MouseEvent) => {
    if (contextMenu) { setContextMenu(null); return; }
    const target = (e.target as SVGElement).closest("path.country");
    if (!target || !gameState) return;
    const id      = target.getAttribute("data-id") || "";
    const country = gameState.countries[id];
    if (!country) return;

    if (country.owner === "player" && !selectedBuilding) {
      setShowProvincePanel(prev => prev === id ? null : id);
      setInspecting(null);
      return;
    }

    if (selectedBuilding && country.owner === "player") {
      const def       = BUILDING_DEFS[selectedBuilding];
      if (def.requiresCoast && country.isCoastal === false) { showNotif(`${def.label} requires a coastal country!`); return; }
      const totalCost = def.cost * buildMultiplier;
      if (gameState.gold < totalCost) { showNotif(`Not enough gold! Need ${totalCost}`); return; }
      const gNode = svgRef.current?.querySelector("g.map-group") as SVGGElement | null;
      let baseX: number | undefined, baseY: number | undefined;
      if (gNode) { const [lx, ly] = d3.pointer(e.nativeEvent, gNode); baseX = lx; baseY = ly; }
      const entries: { type: BuildingType; icon: string; x?: number; y?: number }[] = [];
      for (let i = 0; i < buildMultiplier; i++) {
        const angle = (i / Math.max(1, buildMultiplier)) * Math.PI * 2;
        const radius = i === 0 ? 0 : 6 + (i % 3) * 4;
        entries.push({ type: selectedBuilding, icon: def.icon,
          x: baseX !== undefined ? baseX + Math.cos(angle) * radius : undefined,
          y: baseY !== undefined ? baseY + Math.sin(angle) * radius : undefined,
        });
      }
      setGameState(prev => {
        if (!prev) return prev;
        const c = { ...prev.countries[id], buildings: [...prev.countries[id].buildings, ...entries] };
        return { ...prev, gold: prev.gold - totalCost, countries: { ...prev.countries, [id]: c } };
      });
      for (const en of entries) mpBroadcast({ type: "build", from: myOwnerKeyRef.current, countryId: id, building: en });
      showNotif(`×${buildMultiplier} ${def.label} placed in ${country.name}!`);
      if (buildMultiplier === 1) setSelectedBuilding(null);
    }
  }, [gameState, selectedBuilding, contextMenu, buildMultiplier, mpBroadcast, showNotif]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const target = (e.target as SVGElement).closest("path.country");
    if (!target || !gameState) return;
    const id = target.getAttribute("data-id") || "";
    if (!gameState.countries[id] || gameState.countries[id].owner === "player") return;
    setContextMenu({ x: e.clientX, y: e.clientY, countryId: id });
    setShowProvincePanel(null);
  }, [gameState]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const target = (e.target as SVGElement).closest("path.country");
    setHoveredCountry(target ? target.getAttribute("data-id") : null);
  }, []);

  // ── Province troop redistribution ────────────────────────────────────────────
  const moveProvincePercent = useCallback((countryId: string, fromIdx: number, toIdx: number, amount: number) => {
    setAllProvinces(prev => {
      const provs = prev[countryId] ? [...prev[countryId]] : [];
      if (!provs[fromIdx] || !provs[toIdx]) return prev;
      if (provs[fromIdx].stationPercent <= amount) amount = provs[fromIdx].stationPercent - 10;
      if (amount <= 0) return prev;
      const updated = provs.map((p, i) => {
        if (i === fromIdx) return { ...p, stationPercent: p.stationPercent - amount };
        if (i === toIdx)   return { ...p, stationPercent: p.stationPercent + amount };
        return p;
      });
      return { ...prev, [countryId]: updated };
    });
  }, []);

  // ── Diplomacy handler ─────────────────────────────────────────────────────────
  const PP_COSTS: Record<string, number> = {
    improve: 15, trade: 10, guarantee: 15, diplomat: 100,
    ally: 25, breakAlliance: 15, justify: 30, declareWar: 50,
  };

  const handleDiplomacy = useCallback((action: string) => {
    if (!contextMenu || !gameState) return;
    const c = gameState.countries[contextMenu.countryId];
    if (!c) return;
    if (action !== "inspect") {
      const cost = PP_COSTS[action] ?? 0;
      if (gameState.politicalPower < cost) { showNotif(`Not enough PP! Need ${cost}`); setContextMenu(null); return; }
    }
    switch (action) {
      case "inspect": setInspecting(contextMenu.countryId); break;
      case "improve":
        setGameState(prev => {
          if (!prev) return prev;
          const country = { ...prev.countries[contextMenu.countryId] };
          country.relations = { ...country.relations, player: (country.relations.player || 0) + 10 };
          return { ...prev, politicalPower: prev.politicalPower - PP_COSTS.improve, countries: { ...prev.countries, [contextMenu.countryId]: country } };
        });
        showNotif(`Relations with ${c.name} +10`);
        break;
      case "trade":
        if (gameState.gold < 50) { showNotif("Need 50 gold!"); break; }
        setGameState(prev => {
          if (!prev) return prev;
          const country = { ...prev.countries[contextMenu.countryId] };
          if (country.tradeDeals.includes("player")) { showNotif("Already trading!"); return prev; }
          country.tradeDeals = [...country.tradeDeals, "player"];
          return { ...prev, gold: prev.gold - 50, politicalPower: prev.politicalPower - PP_COSTS.trade, countries: { ...prev.countries, [contextMenu.countryId]: country } };
        });
        showNotif(`Trade deal with ${c.name}!`);
        break;
      case "guarantee":
        setGameState(prev => prev ? { ...prev, politicalPower: prev.politicalPower - PP_COSTS.guarantee, guarantees: prev.guarantees?.includes(contextMenu.countryId) ? prev.guarantees : [...(prev.guarantees || []), contextMenu.countryId] } : prev);
        showNotif(`Guaranteed ${c.name}'s independence`);
        break;
      case "diplomat":
        setGameState(prev => {
          if (!prev) return prev;
          const country = { ...prev.countries[contextMenu.countryId], diplomatUntil: Date.now() + 100000 };
          return { ...prev, politicalPower: prev.politicalPower - PP_COSTS.diplomat, countries: { ...prev.countries, [contextMenu.countryId]: country } };
        });
        showNotif(`Diplomat sent to ${c.name}`);
        break;
      case "ally": {
        const ownerId = c.owner;
        if (!ownerId) { showNotif(`${c.name} is unowned.`); break; }
        setGameState(prev => {
          if (!prev) return prev;
          const rel = prev.countries[contextMenu.countryId]?.relations?.player || 0;
          if (rel < 70) { showNotif(`${c.name} rejected. Need 70+ relations (${rel})`); return prev; }
          if (prev.alliances.includes(ownerId)) return prev;
          showNotif(`✅ Alliance with ${c.name}!`);
          return { ...prev, politicalPower: prev.politicalPower - PP_COSTS.ally, alliances: [...prev.alliances, ownerId] };
        });
        break;
      }
      case "breakAlliance": {
        const ownerId = c.owner;
        if (!ownerId || !gameState.alliances.includes(ownerId)) { showNotif(`Not allied.`); break; }
        setGameState(prev => prev ? { ...prev, politicalPower: prev.politicalPower - PP_COSTS.breakAlliance, alliances: prev.alliances.filter(a => a !== ownerId) } : prev);
        showNotif(`Alliance with ${c.name} broken`);
        break;
      }
      case "justify":
        if (gameState.warGoals.includes(contextMenu.countryId)) { showNotif("Already justified."); break; }
        if (c.owner && gameState.alliances.includes(c.owner)) { showNotif("Break alliance first!"); break; }
        setGameState(prev => {
          if (!prev) return prev;
          const country = { ...prev.countries[contextMenu.countryId] };
          country.relations = { ...country.relations, player: (country.relations.player || 0) - 20 };
          return { ...prev, politicalPower: prev.politicalPower - PP_COSTS.justify, warGoals: [...prev.warGoals, contextMenu.countryId], countries: { ...prev.countries, [contextMenu.countryId]: country } };
        });
        showNotif(`War goal justified on ${c.name}`);
        break;
      case "declareWar":
        if (c.owner && gameState.alliances.includes(c.owner)) { showNotif("Break alliance first!"); break; }
        if (!gameState.warGoals.includes(contextMenu.countryId)) { showNotif("Justify first!"); break; }
        if (isAtWar(gameState.wars, contextMenu.countryId)) { showNotif("Already at war!"); break; }
        setGameState(prev => {
          if (!prev) return prev;
          const country = { ...prev.countries[contextMenu.countryId] };
          country.relations = { ...country.relations, player: (country.relations.player || 0) - 80 };
          return { ...prev, politicalPower: prev.politicalPower - PP_COSTS.declareWar, wars: [...prev.wars, { countryId: contextMenu.countryId, startedAt: Date.now() }], countries: { ...prev.countries, [contextMenu.countryId]: country } };
        });
        if (c.owner?.startsWith("human-")) mpBroadcast({ type: "war_declared", from: myOwnerKeyRef.current, fromName: myNameRef.current, to: c.owner, targetCountryId: contextMenu.countryId });
        showNotif(`⚔ WAR DECLARED on ${c.name}!`);
        break;
      case "attack":
        if (!isAtWar(gameState.wars, contextMenu.countryId)) { showNotif("Not at war."); break; }
        setAttackTarget(contextMenu.countryId);
        setAttackTroops(Math.min(Math.floor(gameState.troops), Math.max(100, Math.floor(gameState.troops / 2))));
        setAttackTanks(Math.floor(gameState.tanks));
        setAttackPlanes(Math.floor(gameState.planes));
        break;
      case "makePeace":
        if (!isAtWar(gameState.wars, contextMenu.countryId)) { showNotif("Not at war."); break; }
        setGameState(prev => {
          if (!prev) return prev;
          const country = { ...prev.countries[contextMenu.countryId] };
          country.relations = { ...country.relations, player: Math.min((country.relations.player || 0) + 30, 0) };
          return { ...prev, politicalPower: prev.politicalPower - 20, wars: removeWar(prev.wars, contextMenu.countryId), warGoals: prev.warGoals.filter(w => w !== contextMenu.countryId), countries: { ...prev.countries, [contextMenu.countryId]: country } };
        });
        setAllProvinces(ap => ({ ...ap, [contextMenu.countryId]: generateProvinces(contextMenu.countryId, c.name) }));
        if (c.owner?.startsWith("human-")) mpBroadcast({ type: "war_ended", from: myOwnerKeyRef.current, fromName: myNameRef.current, to: c.owner, targetCountryId: contextMenu.countryId });
        showNotif(`🕊 Peace with ${c.name}`);
        break;
      case "requestTroops": {
        const ownerId = c.owner;
        if (!ownerId || !gameState.alliances.includes(ownerId)) { showNotif("Not allied."); break; }
        if (lastTroopRequestYear >= gameState.date.year) { showNotif("Already requested this year!"); break; }
        const rel    = c.relations.player || 0;
        const chance = Math.min(0.9, Math.max(0.1, rel / 220));
        if (Math.random() < chance) {
          const gained = Math.floor(c.troops * 0.05);
          setGameState(prev => {
            if (!prev) return prev;
            const country = { ...prev.countries[contextMenu.countryId], troops: Math.max(0, prev.countries[contextMenu.countryId].troops - gained) };
            return { ...prev, troops: prev.troops + gained, countries: { ...prev.countries, [contextMenu.countryId]: country } };
          });
          setLastTroopRequestYear(gameState.date.year);
          showNotif(`✅ ${c.name} sent ${Math.floor(c.troops * 0.05)} troops!`);
        } else {
          setLastTroopRequestYear(gameState.date.year);
          showNotif(`❌ ${c.name} refused.`);
        }
        break;
      }
    }
    setContextMenu(null);
  }, [contextMenu, gameState, showNotif, lastTroopRequestYear, mpBroadcast]);

  // ── AI Advisor ────────────────────────────────────────────────────────────────
  const sendAdvisorMsg = async () => {
    if (!advisorInput.trim() || !gameState) return;
    const userMsg = { role: "user", content: advisorInput };
    setAdvisorMessages(p => [...p, userMsg]);
    setAdvisorInput("");
    setAdvisorLoading(true);
    const playerCountries = Object.values(gameState.countries).filter(c => c.owner === "player");
    const gameContext = {
      date: formatDate(gameState.date),
      playerCountry: getCountryName(gameState.playerCountryId),
      gold: Math.floor(gameState.gold), troops: Math.floor(gameState.troops),
      ownedCountries: playerCountries.map(c => c.name),
      wars: gameState.wars.map(w => gameState.countries[w.countryId]?.name || w.countryId),
      allies: gameState.alliances.map(a => gameState.bots.find(b => b.id === a)?.name || a),
    };
    try {
      const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/strategy-advisor`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}` },
        body: JSON.stringify({ messages: [...advisorMessages, userMsg], gameState: gameContext }),
      });
      if (!resp.ok || !resp.body) throw new Error("Failed");
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "", assistantText = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.startsWith("data: ")) continue;
          const json = line.slice(6).trim();
          if (json === "[DONE]") break;
          try {
            const parsed  = JSON.parse(json);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              assistantText += content;
              setAdvisorMessages(p => { const last = p[p.length - 1]; return last?.role === "assistant" ? [...p.slice(0, -1), { ...last, content: assistantText }] : [...p, { role: "assistant", content: assistantText }]; });
            }
          } catch {}
        }
      }
    } catch { setAdvisorMessages(p => [...p, { role: "assistant", content: "Advisor unavailable." }]); }
    setAdvisorLoading(false);
  };

  // ── Early return ──────────────────────────────────────────────────────────────
  if (!gameState) return (
    <div className="w-full h-full flex items-center justify-center text-white bg-[#0f1420]">
      <div className="text-center">
        <div className="text-4xl mb-3 animate-pulse">🌍</div>
        <div className="text-gray-400 text-sm">Loading world map…</div>
      </div>
    </div>
  );

  const leaderboard         = getLeaderboard(gameState);
  const visibleLeaderboard  = showFullLeaderboard ? leaderboard : leaderboard.slice(0, 4);
  const playerEntry         = leaderboard.find(l => l.id === "player");
  const goldRate            = getGoldRate(gameState);
  const troopRate           = getTroopRate(gameState);
  const ppRate              = getPoliticalPowerRate(gameState);
  const inspectCountry      = inspecting ? gameState.countries[inspecting] : null;
  const ctxCountry          = contextMenu ? gameState.countries[contextMenu.countryId] : null;
  const provincePanelCountry = showProvincePanel ? gameState.countries[showProvincePanel] : null;
  const provincePanelData    = showProvincePanel ? (allProvinces[showProvincePanel] || []) : [];

  const getTroopsInProvince = (countryId: string, prov: Province) =>
    Math.floor((gameState.countries[countryId]?.troops || 0) * prov.stationPercent / 100);

  // Naval info for attack target
  const navalInfo = attackTarget ? canReach(attackTarget, gameState, neighborsRef) : null;

  return (
    <div className="relative w-full h-full" onClick={() => { if (contextMenu) setContextMenu(null); }}>
      {/* Map */}
      <svg ref={svgRef} width="100%" height="100%" className="bg-[#1a1f2e]"
        onClick={handleClick} onContextMenu={handleContextMenu} onMouseMove={handleMouseMove}
        style={{ cursor: selectedBuilding ? "crosshair" : "grab" }}>
        <g className="map-group" />
      </svg>

      {/* Building legend — bottom right of map */}
      <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-10 flex gap-3 pointer-events-none">
        {selectedBuilding && (
          <div className="bg-[#7c3aed]/90 border border-[#a78bfa] rounded-lg px-4 py-1.5 text-white text-xs font-bold">
            🏗 Placing {BUILDING_DEFS[selectedBuilding].label} ×{buildMultiplier} — click your territory — ESC to cancel
          </div>
        )}
      </div>

      {/* Vignette */}
      <div className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.35) 100%)" }} />

      {/* Date / speed */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 bg-[#0f1420]/90 backdrop-blur-sm px-4 py-2 rounded-full border border-[#4a5568]">
        <button onClick={() => setGameState(p => p ? { ...p, speed: Math.max(1, p.speed - 1) } : p)} className="text-gray-400 hover:text-white px-1">◀</button>
        <button onClick={() => setGameState(p => p ? { ...p, paused: !p.paused } : p)} className="text-white hover:text-[#f97316] px-1 text-lg">{gameState.paused ? "▶" : "⏸"}</button>
        <span className="text-white font-mono text-sm min-w-[160px] text-center">{formatDate(gameState.date)}</span>
        <span className="text-[#f97316] text-xs">×{gameState.speed}</span>
        <button onClick={() => setGameState(p => p ? { ...p, speed: Math.min(5, p.speed + 1) } : p)} className="text-gray-400 hover:text-white px-1">▶</button>
      </div>

      {/* Leaderboard */}
      <div className="absolute top-3 left-3 z-20 bg-[#0f1420]/90 backdrop-blur-sm rounded-lg border border-[#4a5568] p-3 min-w-[280px]">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs text-gray-400 font-bold uppercase tracking-wider">Leaderboard</div>
          <button onClick={() => setShowFullLeaderboard(v => !v)} className="text-[10px] text-[#f97316] hover:text-[#fb923c] font-semibold">
            {showFullLeaderboard ? "Show less ▲" : `All (${leaderboard.length}) ▼`}
          </button>
        </div>
        <div className={showFullLeaderboard ? "max-h-[320px] overflow-y-auto pr-1" : ""}>
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-[#0f1420]">
              <tr className="text-gray-500"><th className="text-left w-6">#</th><th className="text-left">Nation</th><th className="text-right">Gold</th><th className="text-right">Troops</th></tr>
            </thead>
            <tbody>
              {visibleLeaderboard.map(entry => (
                <tr key={entry.id} className={entry.id === "player" ? "text-[#a78bfa]" : "text-gray-300"}>
                  <td>{entry.rank}</td>
                  <td className="flex items-center gap-1 py-0.5">
                    <span className="w-2 h-2 rounded-full inline-block flex-shrink-0" style={{ backgroundColor: entry.color }} />
                    <span className="truncate max-w-[120px]">{entry.name}</span>
                  </td>
                  <td className="text-right">{Math.floor(entry.gold).toLocaleString()}</td>
                  <td className="text-right">{Math.floor(entry.troops).toLocaleString()}</td>
                </tr>
              ))}
              {!showFullLeaderboard && playerEntry && !visibleLeaderboard.some(t => t.id === "player") && (
                <tr className="text-[#a78bfa] border-t border-[#4a5568]">
                  <td>{playerEntry.rank}</td>
                  <td className="flex items-center gap-1"><span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: PLAYER_COLOR }} />You</td>
                  <td className="text-right">{Math.floor(playerEntry.gold).toLocaleString()}</td>
                  <td className="text-right">{Math.floor(playerEntry.troops).toLocaleString()}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Building dot legend */}
      <div className="absolute top-3 left-3 z-20 mt-[200px]">
        <div className="bg-[#0f1420]/80 backdrop-blur-sm rounded-lg border border-[#4a5568] p-2 text-[10px] text-gray-400">
          {Object.entries(BUILDING_COLORS).map(([type, color]) => (
            <div key={type} className="flex items-center gap-1.5 mb-0.5">
              <span className="w-2.5 h-2.5 rounded-full inline-block border border-black/40" style={{ backgroundColor: color }} />
              <span className="capitalize">{type}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Stats */}
      <div className="absolute bottom-20 left-3 z-20 bg-[#0f1420]/90 backdrop-blur-sm rounded-lg border border-[#4a5568] p-3 min-w-[220px]">
        <div className="text-sm text-white mb-1">⚔ Troops: <span className="font-bold">{Math.floor(gameState.troops).toLocaleString()}</span><span className="text-green-400 text-xs ml-1">+{troopRate}/s</span></div>
        <div className="text-sm text-white mb-1">🚜 Tanks: <span className="font-bold">{Math.floor(gameState.tanks).toLocaleString()}</span></div>
        <div className="text-sm text-white mb-1">✈ Planes: <span className="font-bold">{Math.floor(gameState.planes).toLocaleString()}</span></div>
        <div className="text-sm text-white mb-1">💰 Gold: <span className="font-bold">{Math.floor(gameState.gold).toLocaleString()}</span><span className="text-green-400 text-xs ml-1">+{goldRate}/s</span></div>
        <div className="text-sm text-white">🎖 PP: <span className="font-bold">{Math.floor(gameState.politicalPower).toLocaleString()}</span><span className="text-green-400 text-xs ml-1">+{ppRate.toFixed(1)}/s</span></div>
      </div>

      {/* Allies */}
      {gameState.alliances.length > 0 && (
        <div className="absolute bottom-3 left-3 z-20 bg-[#0f1420]/90 backdrop-blur-sm rounded-lg border border-cyan-500/50 p-2 min-w-[220px] max-h-[100px] overflow-y-auto">
          <div className="text-xs text-cyan-400 mb-1 font-bold uppercase tracking-wider">🕊 Allies</div>
          {gameState.alliances.map(allyId => {
            const bot = gameState.bots.find(b => b.id === allyId);
            return bot ? (
              <div key={allyId} className="flex items-center gap-2 text-xs text-gray-200">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: bot.color }} />
                {bot.name}
              </div>
            ) : null;
          })}
        </div>
      )}

      {/* Hotbar */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 flex items-end gap-2">
        <div className="flex gap-1">
          {BUILDING_SLOTS.map((bt, i) => {
            const def        = BUILDING_DEFS[bt];
            const isSelected = selectedBuilding === bt;
            const dotColor   = BUILDING_COLORS[bt];
            return (
              <button key={bt} onClick={e => { e.stopPropagation(); setSelectedBuilding(isSelected ? null : bt); }}
                className={`w-14 h-14 rounded-lg flex flex-col items-center justify-center text-xs transition border ${isSelected ? "bg-[#7c3aed] border-[#a78bfa] text-white" : "bg-[#0f1420]/90 border-[#4a5568] text-gray-300 hover:bg-[#1a2030]"}`}
                title={`${def.label} — ${def.cost * buildMultiplier}g — ${def.description}`}>
                <span className="w-4 h-4 rounded-full border border-black/40 mb-1" style={{ backgroundColor: dotColor }} />
                <span className="text-[9px] leading-none">{def.label.slice(0,4)}</span>
                <span className="text-[8px] text-gray-500">{i + 1}</span>
              </button>
            );
          })}
        </div>
        <div className="flex flex-col gap-1 ml-1">
          {([1, 5, 10] as const).map(m => (
            <button key={m} onClick={e => { e.stopPropagation(); setBuildMultiplier(m); }}
              className={`w-10 h-[17px] rounded text-[10px] font-bold border transition ${buildMultiplier === m ? "bg-[#f97316] border-[#fb923c] text-white" : "bg-[#0f1420]/90 border-[#4a5568] text-gray-400 hover:bg-[#1a2030]"}`}>
              ×{m}
            </button>
          ))}
        </div>
      </div>

      {/* Side rail */}
      <div className="absolute top-1/2 right-3 -translate-y-1/2 z-20 flex flex-col gap-2">
        {[
          { icon: "🔬", key: "research", show: showResearch, set: setShowResearch },
          { icon: "🏆", key: "goals",    show: showGoals,    set: setShowGoals },
          { icon: "🔔", key: "notif",    show: showNotifLog, set: setShowNotifLog },
          { icon: "🏛", key: "forms",    show: showFormables,set: setShowFormables },
        ].map(({ icon, key, show, set }) => (
          <button key={key} onClick={() => set((v: boolean) => !v)}
            className="w-12 h-12 rounded-lg bg-[#0f1420]/90 border border-[#4a5568] text-white text-xl hover:bg-[#1a2030] flex items-center justify-center relative">
            {icon}
            {key === "goals" && GOALS.length - gameState.completedGoals.length > 0 && (
              <span className="absolute -top-1 -right-1 bg-[#f97316] text-white text-[9px] rounded-full w-4 h-4 flex items-center justify-center font-bold">{GOALS.length - gameState.completedGoals.length}</span>
            )}
            {key === "forms" && (() => {
              const ready = FORMABLES.filter(f => !(gameState.formedNations || []).includes(f.id) && f.requiredCountryIds.every(id => gameState.countries[id]?.owner === "player")).length;
              return ready > 0 ? <span className="absolute -top-1 -right-1 bg-green-500 text-white text-[9px] rounded-full w-4 h-4 flex items-center justify-center font-bold">{ready}</span> : null;
            })()}
          </button>
        ))}
      </div>

      {/* Exit */}
      <div className="absolute top-3 right-3 z-20">
        <button onClick={onExit} className="px-3 py-1.5 rounded-lg bg-[#0f1420]/90 border border-[#4a5568] text-gray-300 hover:text-white hover:bg-[#1a2030] text-xs font-bold transition">✕ Exit</button>
      </div>

      {/* ── Province Panel ───────────────────────────────────────────────────── */}
      {showProvincePanel && provincePanelCountry && (
        <div className="absolute top-3 right-3 z-30 w-80 bg-[#0f1420]/95 border border-[#a78bfa]/60 rounded-xl p-4 max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
          <div className="flex justify-between items-center mb-2">
            <h3 className="text-white font-bold text-sm">🗺 {provincePanelCountry.name}</h3>
            <button onClick={() => setShowProvincePanel(null)} className="text-gray-400 hover:text-white text-sm">✕</button>
          </div>

          {/* Province summary bar */}
          <div className="flex gap-0.5 h-3 rounded overflow-hidden mb-3">
            {provincePanelData.map(p => (
              <div key={p.id} className="h-full transition-all" style={{
                width: `${p.stationPercent}%`,
                backgroundColor: p.isFallen ? "#ef4444" : p.isCapital ? "#f97316" : "#7c3aed",
                opacity: p.isFallen ? 0.4 : 1,
              }} title={`${p.name}: ${p.stationPercent}%`} />
            ))}
          </div>

          <div className="text-[10px] text-gray-400 mb-3">
            Total troops: <span className="text-white font-bold">{Math.floor(provincePanelCountry.troops).toLocaleString()}</span>
            &nbsp;· Click ↑↓ to move 10% between provinces · Attack from right-click → Attack
          </div>

          <div className="space-y-2">
            {provincePanelData.map((prov, idx) => {
              const troopsHere = getTroopsInProvince(showProvincePanel!, prov);
              const isFront    = !prov.isCapital && !prov.isFallen &&
                provincePanelData.filter(p => !p.isFallen && !p.isCapital).sort((a, b) => a.stationPercent - b.stationPercent)[0]?.id === prov.id;
              return (
                <div key={prov.id} className={`p-2.5 rounded-lg border text-xs ${
                  prov.isFallen  ? "border-red-500/40 bg-red-900/10 opacity-60" :
                  prov.isCapital ? "border-yellow-400/50 bg-yellow-900/10" :
                  isFront        ? "border-orange-400/50 bg-orange-900/10" :
                                   "border-[#4a5568] bg-[#1a2030]"
                }`}>
                  <div className="flex justify-between items-start mb-1.5">
                    <div>
                      <span className="text-white font-bold mr-1">
                        {prov.isFallen ? "💀" : prov.isCapital ? "🏛" : isFront ? "⚔" : "🗺"}
                      </span>
                      <span className="text-white font-bold">{prov.name}</span>
                      {prov.isFallen && <span className="text-red-400 ml-1 text-[10px]">FALLEN</span>}
                      {isFront && !prov.isFallen && <span className="text-orange-400 ml-1 text-[10px] bg-orange-900/30 px-1 rounded">FRONT</span>}
                    </div>
                    <div className={`text-[9px] px-1 py-0.5 rounded font-bold ${
                      prov.terrainLabel === "Mountains" ? "bg-slate-700 text-slate-300" :
                      prov.terrainLabel === "Forest" || prov.terrainLabel === "Jungle" ? "bg-green-900 text-green-300" :
                      prov.terrainLabel === "Coastal" ? "bg-blue-900 text-blue-300" :
                      prov.terrainLabel === "Desert" ? "bg-yellow-900 text-yellow-300" :
                      "bg-[#2d3b2d] text-gray-400"
                    }`}>
                      {prov.terrainLabel}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 mb-1">
                    <div className="flex-1 h-1.5 bg-[#0f1420] rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{
                        width: `${prov.stationPercent}%`,
                        backgroundColor: prov.isFallen ? "#ef4444" : prov.isCapital ? "#f97316" : "#7c3aed"
                      }} />
                    </div>
                    <span className="text-[10px] text-gray-400 w-8 text-right">{prov.stationPercent}%</span>
                  </div>

                  <div className="flex justify-between items-center">
                    <div className="space-y-0.5">
                      <div className="text-green-400">{troopsHere.toLocaleString()} troops</div>
                      <div className="text-cyan-400 text-[9px]">+{Math.round(prov.terrainBonus * 100)}% defense · pop {prov.population}</div>
                    </div>
                    {!prov.isFallen && (
                      <div className="flex gap-1">
                        {idx > 0 && !provincePanelData[idx - 1]?.isFallen && prov.stationPercent > 10 && (
                          <button onClick={() => moveProvincePercent(showProvincePanel!, idx, idx - 1, 10)}
                            className="w-6 h-6 rounded bg-[#2d3b2d] border border-[#4a5568] text-white hover:bg-[#3d4b3d] text-xs flex items-center justify-center">↑</button>
                        )}
                        {idx < provincePanelData.length - 1 && !provincePanelData[idx + 1]?.isFallen && prov.stationPercent > 10 && (
                          <button onClick={() => moveProvincePercent(showProvincePanel!, idx, idx + 1, 10)}
                            className="w-6 h-6 rounded bg-[#2d3b2d] border border-[#4a5568] text-white hover:bg-[#3d4b3d] text-xs flex items-center justify-center">↓</button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Province capture status */}
          {provincePanelData.some(p => p.isFallen) && (
            <div className="mt-2 p-2 bg-red-900/20 border border-red-500/30 rounded text-[10px] text-red-300">
              ⚠ {provincePanelData.filter(p => p.isFallen).length} province(s) under enemy occupation.
              Recapture by declaring war and attacking!
            </div>
          )}
        </div>
      )}

      {/* ── Attack modal ─────────────────────────────────────────────────────── */}
      {attackTarget && !battle && navalInfo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setAttackTarget(null)}>
          <div className="bg-[#0f1420] border border-red-500/60 rounded-xl p-6 w-[420px] shadow-2xl" onClick={e => e.stopPropagation()}>
            {(() => {
              const tc    = gameState.countries[attackTarget];
              const provs = allProvinces[attackTarget] || [];
              const front = getFrontProvince(provs);
              const isCapBattle = !provs.some(p => !p.isFallen && !p.isCapital);
              const fallenCount = provs.filter(p => p.isFallen).length;

              const maxTroops = navalInfo.naval && navalInfo.navalCap > 0
                ? Math.min(Math.floor(gameState.troops), navalInfo.navalCap)
                : Math.floor(gameState.troops);

              return (
                <>
                  <h3 className="text-white font-bold text-lg mb-2">⚔ Attack {tc?.name}</h3>

                  {/* Province target info */}
                  {front && (
                    <div className={`mb-3 p-2 rounded text-xs border ${isCapBattle ? "bg-yellow-900/30 border-yellow-400/50 text-yellow-300" : "bg-orange-900/20 border-orange-400/40 text-orange-300"}`}>
                      <div className="font-bold">Target: {front.name} {isCapBattle && "🏛 CAPITAL"}</div>
                      <div>Terrain: {front.terrainLabel} (+{Math.round(front.terrainBonus * 100)}% defense)</div>
                      {fallenCount > 0 && <div className="text-green-400 mt-0.5">{fallenCount} province(s) already captured</div>}
                    </div>
                  )}

                  {/* Naval invasion banner */}
                  {navalInfo.naval && (
                    <div className={`mb-3 p-2 rounded text-xs border ${navalInfo.ok ? "bg-blue-900/30 border-blue-400/50 text-blue-300" : "bg-red-900/30 border-red-500/50 text-red-300"}`}>
                      {navalInfo.ok
                        ? `⚓ Naval invasion — ${getNavalCap(gameState) / 1000} port(s) — max ${navalInfo.navalCap.toLocaleString()} troops`
                        : `🚫 ${navalInfo.reason}`}
                    </div>
                  )}

                  {/* Flanking bonus preview */}
                  {(() => {
                    const nbs = neighborsRef.current[attackTarget] || new Set<string>();
                    const flankCount = Math.min([...nbs].filter(n => gameState.countries[n]?.owner === "player").length, 3);
                    const hasSupply  = Object.values(gameState.countries).filter(c => c.owner === "player").some(c => (neighborsRef.current[c.id] || new Set()).has(attackTarget));
                    return (
                      <div className="mb-3 flex gap-2 text-[10px]">
                        {flankCount > 0 && (
                          <span className="bg-green-900/40 border border-green-500/40 text-green-300 rounded px-1.5 py-0.5">
                            ⚡ {flankCount} flank{flankCount > 1 ? "s" : ""} +{flankCount * 8}% atk
                          </span>
                        )}
                        {!hasSupply && (
                          <span className="bg-yellow-900/40 border border-yellow-500/40 text-yellow-300 rounded px-1.5 py-0.5">
                            📦 No supply +15% losses
                          </span>
                        )}
                      </div>
                    );
                  })()}

                  <div className="space-y-3 mb-4">
                    <div>
                      <label className="text-xs text-gray-400 flex justify-between">
                        <span>Troops: <span className="text-white font-bold">{attackTroops.toLocaleString()}</span></span>
                        <span className="text-gray-500">max {maxTroops.toLocaleString()}</span>
                      </label>
                      <input type="range" min={1} max={Math.max(1, maxTroops)} value={Math.min(attackTroops, maxTroops)}
                        onChange={e => setAttackTroops(+e.target.value)} className="w-full mt-1 accent-red-500" />
                    </div>
                    <div>
                      <label className="text-xs text-gray-400">Tanks: <span className="text-white font-bold">{attackTanks}</span> <span className="text-yellow-400">(×10 strength)</span></label>
                      <input type="range" min={0} max={Math.floor(gameState.tanks)} value={attackTanks} onChange={e => setAttackTanks(+e.target.value)} className="w-full mt-1 accent-yellow-500" />
                    </div>
                    <div>
                      <label className="text-xs text-gray-400">Planes: <span className="text-white font-bold">{attackPlanes}</span> <span className="text-cyan-400">(air superiority)</span></label>
                      <input type="range" min={0} max={Math.floor(gameState.planes)} value={attackPlanes} onChange={e => setAttackPlanes(+e.target.value)} className="w-full mt-1 accent-cyan-500" />
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <button disabled={!navalInfo.ok}
                      onClick={() => {
                        if (!tc || !navalInfo.ok) return;
                        const frontProv   = getFrontProvince(allProvinces[attackTarget] || []);
                        const isCapBattle = !(allProvinces[attackTarget] || []).some(p => !p.isFallen && !p.isCapital);
                        const frontTroops = frontProv ? Math.floor(tc.troops * frontProv.stationPercent / 100) : Math.floor(tc.troops);
                        const fortCount   = tc.buildings.filter(b => b.type === "fort").length;
                        const sendTroops  = Math.min(attackTroops, maxTroops);

                        setGameState(prev => prev ? {
                          ...prev,
                          troops: Math.max(0, prev.troops - sendTroops),
                          tanks:  Math.max(0, prev.tanks  - attackTanks),
                          planes: Math.max(0, prev.planes - attackPlanes),
                        } : prev);

                        setBattle({
                          targetId: attackTarget, provinceId: frontProv?.id || "",
                          isCapitalBattle: isCapBattle,
                          attacker: sendTroops, defender: frontTroops,
                          attackerPlanes: attackPlanes, defenderPlanes: Math.floor(tc.planes),
                          attackerTanks: attackTanks, progress: 0,
                          defenseMult: 1 + fortCount * 0.02, initialDefender: frontTroops,
                        });

                        if (tc.owner?.startsWith("human-")) {
                          mpBroadcast({ type: "attack_started", from: myOwnerKeyRef.current, fromName: myNameRef.current, targetCountryId: attackTarget, troops: sendTroops });
                        }

                        showNotif(`⚔ Attacking ${tc.name}${navalInfo.naval ? " (Naval)" : ""}!`);
                        setAttackTarget(null);
                      }}
                      className="flex-1 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white font-bold transition disabled:opacity-40 disabled:cursor-not-allowed">
                      {navalInfo.naval ? "⚓ Launch Naval Invasion!" : "⚔ Launch Attack!"}
                    </button>
                    <button onClick={() => setAttackTarget(null)} className="px-4 py-2 rounded-lg bg-[#2d3b2d] border border-[#4a5568] text-gray-300 hover:text-white">Cancel</button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* ── Battle modal ─────────────────────────────────────────────────────── */}
      {battle && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 pointer-events-none">
          <div className="bg-[#0f1420]/98 border-2 border-red-500/70 rounded-xl p-5 w-96 shadow-2xl pointer-events-auto">
            {(() => {
              const tc   = gameState.countries[battle.targetId];
              const prov = (allProvinces[battle.targetId] || []).find(p => p.id === battle.provinceId);
              const now  = Date.now();
              const isForce  = !!(battle.forceAttackUntil && now < battle.forceAttackUntil);
              const isLast   = !!(battle.lastStandUntil   && now < battle.lastStandUntil);
              const isAiLast = !!(battle.aiLastStandUntil && now < battle.aiLastStandUntil);
              const canLast  = !isLast && !battle.lastStandUntil;

              const atkTotal = battle.attacker + battle.defender || 1;
              const atkPct   = (battle.attacker / atkTotal) * 100;
              return (
                <>
                  <div className="text-white font-bold text-base mb-1 flex items-center gap-2">
                    ⚔ Battle for {tc?.name}
                    {battle.isCapitalBattle && <span className="text-yellow-400 text-xs bg-yellow-900/40 border border-yellow-400/40 px-1.5 py-0.5 rounded">CAPITAL</span>}
                  </div>
                  {prov && (
                    <div className="text-[10px] text-orange-400 mb-2">
                      Province: {prov.name} · {prov.terrainLabel} +{Math.round(prov.terrainBonus * 100)}% def
                    </div>
                  )}
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-green-400">You: {Math.floor(battle.attacker).toLocaleString()} {battle.attackerTanks > 0 && `+🚜${Math.floor(battle.attackerTanks)}`}</span>
                    <span className="text-red-400">{tc?.name}: {Math.floor(battle.defender).toLocaleString()}</span>
                  </div>
                  <div className="flex gap-0.5 h-4 mb-3 rounded-full overflow-hidden">
                    <div className="bg-green-500 transition-all" style={{ width: `${atkPct}%` }} />
                    <div className="bg-red-500 transition-all" style={{ width: `${100 - atkPct}%` }} />
                  </div>
                  {(battle.attackerPlanes > 0 || battle.defenderPlanes > 0) && (
                    <div className="flex justify-between text-[10px] mb-1">
                      <span className="text-cyan-400">✈ You: {Math.floor(battle.attackerPlanes)}</span>
                      <span className={battle.attackerPlanes > battle.defenderPlanes ? "text-cyan-400 font-bold" : "text-orange-400"}>
                        {battle.attackerPlanes > battle.defenderPlanes ? "Air superiority!" : "Enemy has air superiority"}
                      </span>
                      <span className="text-orange-400">✈ Enemy: {Math.floor(battle.defenderPlanes)}</span>
                    </div>
                  )}
                  <div className="text-[10px] text-gray-400 mb-1 flex justify-between">
                    <span>Assault progress</span><span>{Math.floor(battle.progress)}%</span>
                  </div>
                  <div className="w-full h-2 bg-[#2d3b2d] rounded-full mb-3">
                    <div className="h-full bg-[#f97316] rounded-full transition-all" style={{ width: `${battle.progress}%` }} />
                  </div>
                  <div className="flex flex-wrap gap-1 mb-3 text-[10px]">
                    {isForce  && <span className="px-2 py-0.5 rounded bg-orange-500/30 text-orange-300 border border-orange-400/50">⚡ Force Attack</span>}
                    {isLast   && <span className="px-2 py-0.5 rounded bg-purple-500/30 text-purple-300 border border-purple-400/50">🛡 Last Stand</span>}
                    {isAiLast && <span className="px-2 py-0.5 rounded bg-red-500/30 text-red-300 border border-red-400/50">🛡 Enemy Last Stand</span>}
                  </div>
                  <div className="flex gap-2 mt-1">
                    <button onClick={() => setBattle(b => b ? { ...b, forceAttackUntil: Date.now() + 10000 } : b)}
                      disabled={isForce}
                      className="flex-1 py-1.5 rounded bg-orange-600 hover:bg-orange-500 text-white text-xs font-bold disabled:opacity-40">
                      {isForce ? "⚡ Forcing…" : "⚡ Force Attack"}
                    </button>
                    <button onClick={() => { setBattle(b => b ? { ...b, lastStandUntil: Date.now() + 20000 } : b); }}
                      disabled={!canLast}
                      className="flex-1 py-1.5 rounded bg-purple-700 hover:bg-purple-600 text-white text-xs font-bold disabled:opacity-40">
                      {isLast ? "🛡 Defending…" : "🛡 Last Stand"}
                    </button>
                  </div>
                  <button onClick={() => {
                    setGameState(prev => prev ? { ...prev, troops: prev.troops + battle.attacker, tanks: prev.tanks + battle.attackerTanks, planes: prev.planes + battle.attackerPlanes } : prev);
                    showNotif("🏃 Retreated.");
                    setBattle(null);
                  }} className="w-full mt-2 py-1.5 rounded bg-[#2d3b2d] border border-[#4a5568] text-gray-300 hover:text-white text-xs">
                    🏃 Retreat (return troops)
                  </button>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* Defender battle view (multiplayer) */}
      {defenderBattle && !battle && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-40 w-80 bg-[#0f1420]/95 border border-orange-500/60 rounded-xl p-4 pointer-events-auto">
          <div className="text-orange-400 font-bold text-sm mb-2">⚠ {defenderBattle.attackerName} attacks {gameState.countries[defenderBattle.targetId]?.name}!</div>
          <div className="flex justify-between text-xs mb-1">
            <span className="text-red-400">Attacker: {Math.floor(defenderBattle.attacker).toLocaleString()}</span>
            <span className="text-green-400">Defenders: {Math.floor(defenderBattle.defender).toLocaleString()}</span>
          </div>
          <div className="flex gap-0.5 h-2 rounded-full overflow-hidden mb-1">
            <div className="bg-red-500" style={{ width: `${(defenderBattle.attacker / (defenderBattle.attacker + defenderBattle.defender)) * 100}%` }} />
            <div className="bg-green-500" style={{ width: `${(defenderBattle.defender / (defenderBattle.attacker + defenderBattle.defender)) * 100}%` }} />
          </div>
          <div className="text-[10px] text-gray-400">Assault: {Math.floor(defenderBattle.progress)}%</div>
        </div>
      )}

      {/* Research */}
      {showResearch && (
        <div className="absolute top-1/2 right-20 -translate-y-1/2 z-30 w-80 bg-[#0f1420]/95 border border-[#4a5568] rounded-xl p-4 max-h-[70vh] overflow-y-auto">
          <div className="flex justify-between items-center mb-3">
            <h3 className="text-white font-bold">🔬 Research</h3>
            <button onClick={() => setShowResearch(false)} className="text-gray-400 hover:text-white">✕</button>
          </div>
          {gameState.activeResearch && (() => {
            const def = RESEARCH_DEFS.find(r => r.id === gameState.activeResearch!.id);
            if (!def) return null;
            const pct = Math.min(100, ((Date.now() - gameState.activeResearch.startedAt) / def.durationMs) * 100);
            return (
              <div className="mb-3 p-2 rounded bg-[#1a2030]">
                <div className="text-xs text-cyan-400 font-bold">Researching: {def.label}</div>
                <div className="w-full h-2 bg-[#0f1420] rounded mt-1"><div className="h-full bg-cyan-500 rounded" style={{ width: `${pct}%` }} /></div>
                <div className="text-[10px] text-gray-400 text-right">{Math.ceil((def.durationMs - (Date.now() - gameState.activeResearch.startedAt)) / 1000)}s</div>
              </div>
            );
          })()}
          <div className="space-y-2">
            {RESEARCH_DEFS.map(r => {
              const lvl = gameState.researchLevels?.[r.id] || 0;
              const maxed = lvl >= 5;
              const isActive = gameState.activeResearch?.id === r.id;
              const cost = r.cost * (lvl + 1);
              return (
                <div key={r.id} className={`p-2 rounded border ${maxed ? "border-green-500/50 bg-green-900/20" : "border-[#4a5568] bg-[#1a2030]"}`}>
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="text-sm text-white font-bold">{r.label} <span className="text-cyan-400 text-xs">Lv{lvl}/5</span></div>
                      <div className="text-[10px] text-gray-400">{r.description} · +{lvl * 10}%</div>
                      <div className="text-[10px] text-yellow-400">{cost}g · {r.durationMs / 1000}s</div>
                    </div>
                    <button disabled={maxed || !!gameState.activeResearch || isActive || gameState.gold < cost}
                      onClick={() => { setGameState(prev => prev ? { ...prev, gold: prev.gold - cost, activeResearch: { id: r.id, startedAt: Date.now() } } : prev); showNotif(`🔬 Researching ${r.label}…`); }}
                      className="px-2 py-1 rounded bg-cyan-700 hover:bg-cyan-600 text-white text-xs disabled:opacity-30">
                      {maxed ? "Max" : isActive ? "Active" : `→ Lv${lvl + 1}`}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Goals */}
      {showGoals && (
        <div className="absolute top-1/2 right-20 -translate-y-1/2 z-30 w-80 bg-[#0f1420]/95 border border-[#4a5568] rounded-xl p-4 max-h-[70vh] overflow-y-auto">
          <div className="flex justify-between items-center mb-3">
            <h3 className="text-white font-bold">🏆 Goals</h3>
            <button onClick={() => setShowGoals(false)} className="text-gray-400 hover:text-white">✕</button>
          </div>
          <div className="space-y-2">
            {GOALS.map(g => {
              const done = gameState.completedGoals.includes(g.id);
              let progress = "";
              if (g.id === "continent") {
                const cont = CONTINENTS[gameState.playerCountryId];
                if (cont) { const inC = Object.keys(CONTINENTS).filter(id => CONTINENTS[id] === cont && gameState.countries[id]); progress = `${inC.filter(id => gameState.countries[id]?.owner === "player").length}/${inC.length} (${CONTINENT_NAMES[cont]})`; }
              } else if (g.id === "ten") { const c = Object.values(gameState.countries).filter(c => c.owner === "player").length; progress = `${c}/10`; }
              else if (g.id === "twentyfive") { const c = Object.values(gameState.countries).filter(c => c.owner === "player").length; progress = `${c}/25`; }
              return (
                <div key={g.id} className={`p-2 rounded border ${done ? "border-green-500/50 bg-green-900/20" : "border-[#4a5568] bg-[#1a2030]"}`}>
                  <div className="text-sm text-white font-bold">{g.label} {done && "✅"}</div>
                  <div className="text-[10px] text-gray-400">{g.description}</div>
                  <div className="text-[10px] text-cyan-400">{progress} · +{g.reward} PP</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Notification log */}
      {showNotifLog && (
        <div className="absolute top-1/2 right-20 -translate-y-1/2 z-30 w-80 max-h-[70vh] bg-[#0f1420]/95 border border-[#4a5568] rounded-xl p-4 overflow-y-auto">
          <div className="flex justify-between items-center mb-3">
            <h3 className="text-white font-bold">🔔 Event Log</h3>
            <button onClick={() => setShowNotifLog(false)} className="text-gray-400 hover:text-white">✕</button>
          </div>
          {gameState.notifications.length === 0
            ? <div className="text-xs text-gray-500 text-center py-4">No events yet.</div>
            : <div className="space-y-1">{gameState.notifications.map(n => (
                <div key={n.id} className="text-xs text-gray-300 p-2 bg-[#1a2030] rounded">
                  <div>{n.message}</div>
                  <div className="text-[9px] text-gray-500">{new Date(n.timestamp).toLocaleTimeString()}</div>
                </div>
              ))}</div>
          }
        </div>
      )}

      {/* Formables */}
      {showFormables && (
        <div className="absolute top-1/2 right-20 -translate-y-1/2 z-30 w-80 bg-[#0f1420]/95 border border-[#4a5568] rounded-xl p-4 max-h-[70vh] overflow-y-auto">
          <div className="flex justify-between items-center mb-3">
            <h3 className="text-white font-bold">🏛 Formable Nations</h3>
            <button onClick={() => setShowFormables(false)} className="text-gray-400 hover:text-white">✕</button>
          </div>
          <div className="space-y-2">
            {FORMABLES.map(f => {
              const formed    = (gameState.formedNations || []).includes(f.id);
              const owned     = f.requiredCountryIds.filter(id => gameState.countries[id]?.owner === "player").length;
              const total     = f.requiredCountryIds.length;
              const ready     = owned === total && !formed;
              const canAfford = gameState.politicalPower >= f.ppCost;
              return (
                <div key={f.id} className={`p-2 rounded border ${formed ? "border-green-500/50 bg-green-900/20" : ready ? "border-yellow-400/60 bg-yellow-900/10" : "border-[#4a5568] bg-[#1a2030]"}`}>
                  <div className="flex justify-between items-start gap-2">
                    <div>
                      <div className="text-sm text-white font-bold">{f.flag} {f.name} {formed && "✅"}</div>
                      <div className="text-[10px] text-cyan-400">{owned}/{total} owned · {f.ppCost} PP</div>
                    </div>
                    <button disabled={formed || !ready || !canAfford}
                      onClick={() => {
                        setGameState(prev => {
                          if (!prev || (prev.formedNations || []).includes(f.id)) return prev;
                          if (!f.requiredCountryIds.every(id => prev.countries[id]?.owner === "player")) return prev;
                          if (prev.politicalPower < f.ppCost) return prev;
                          const newCountries = { ...prev.countries };
                          for (const id of f.requiredCountryIds) if (newCountries[id]) newCountries[id] = { ...newCountries[id], color: f.color };
                          return { ...prev, politicalPower: prev.politicalPower - f.ppCost, formedNations: [...(prev.formedNations || []), f.id], countries: newCountries };
                        });
                        showNotif(`🏛 ${f.name} FORMED!`);
                      }}
                      className="px-2 py-1 rounded bg-yellow-600 hover:bg-yellow-500 text-white text-xs font-bold disabled:opacity-30">
                      {formed ? "Formed" : ready ? (canAfford ? "Form!" : "Need PP") : `${owned}/${total}`}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* AI Advisor */}
      <div className="absolute bottom-3 right-3 z-20">
        <button onClick={() => setShowAdvisor(!showAdvisor)} className="px-4 py-2 rounded-lg bg-[#f97316] text-white font-bold hover:bg-[#ea580c] transition text-sm">
          🧠 Advisor
        </button>
      </div>
      {showAdvisor && (
        <div className="absolute bottom-14 right-3 z-30 w-80 h-96 bg-[#0f1420]/95 backdrop-blur-md border border-[#4a5568] rounded-xl flex flex-col overflow-hidden">
          <div className="p-3 border-b border-[#4a5568] flex justify-between items-center">
            <span className="text-white font-bold text-sm">🧠 Strategy Advisor</span>
            <button onClick={() => setShowAdvisor(false)} className="text-gray-400 hover:text-white">✕</button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {advisorMessages.length === 0 && <div className="text-gray-500 text-xs text-center mt-8">Ask for strategic advice…</div>}
            {advisorMessages.map((m, i) => (
              <div key={i} className={`text-xs p-2 rounded ${m.role === "user" ? "bg-[#7c3aed]/30 text-white ml-4" : "bg-[#2d3b2d]/50 text-gray-200 mr-4"}`}>{m.content}</div>
            ))}
          </div>
          <div className="p-2 border-t border-[#4a5568] flex gap-2">
            <input value={advisorInput} onChange={e => setAdvisorInput(e.target.value)} onKeyDown={e => e.key === "Enter" && sendAdvisorMsg()}
              placeholder="Ask for advice…" className="flex-1 px-2 py-1 rounded bg-[#1a2030] text-white text-xs border border-[#4a5568] focus:outline-none" />
            <button onClick={sendAdvisorMsg} disabled={advisorLoading} className="px-3 py-1 rounded bg-[#f97316] text-white text-xs font-bold disabled:opacity-50">
              {advisorLoading ? "…" : "Send"}
            </button>
          </div>
        </div>
      )}

      {/* Context menu */}
      {contextMenu && ctxCountry && (
        <div className="fixed z-40 bg-[#0f1420]/95 backdrop-blur-md border border-[#4a5568] rounded-xl py-2 min-w-[220px] shadow-2xl overflow-y-auto"
          style={{ left: Math.min(contextMenu.x, window.innerWidth - 240), top: Math.min(contextMenu.y, Math.max(8, window.innerHeight - 400)), maxHeight: Math.min(window.innerHeight - 16, 500) }}
          onClick={e => e.stopPropagation()}>
          <div className="px-3 py-1 text-white font-bold text-sm border-b border-[#4a5568] mb-1 flex items-center gap-2">
            {getCountryFlag(contextMenu.countryId)} {ctxCountry.name}
            {ctxCountry.owner && <span className="text-[9px] text-gray-500">{ctxCountry.owner === "player" ? "" : ctxCountry.owner.startsWith("human-") ? "👤 Human" : "🤖 AI"}</span>}
          </div>
          {(() => {
            const isAlly  = !!(ctxCountry.owner && gameState.alliances.includes(ctxCountry.owner));
            const hasGoal = gameState.warGoals.includes(contextMenu.countryId);
            const atWar   = isAtWar(gameState.wars, contextMenu.countryId);
            const provs   = allProvinces[contextMenu.countryId] || [];
            const front   = getFrontProvince(provs);
            const fallen  = provs.filter(p => p.isFallen).length;
            const reach   = canReach(contextMenu.countryId, gameState, neighborsRef);
            return (
              <>
                <button onClick={() => handleDiplomacy("inspect")} className="w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-[#2d3b2d]">👁 Inspect</button>
                <button onClick={() => handleDiplomacy("improve")} className="w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-[#2d3b2d]">🤝 Improve Relations ({PP_COSTS.improve} PP)</button>
                <button onClick={() => handleDiplomacy("justify")} disabled={isAlly || hasGoal || atWar}
                  className="w-full px-3 py-1.5 text-left text-sm disabled:text-gray-600 text-gray-200 hover:bg-[#2d3b2d]">
                  📜 Justify War {hasGoal ? "✅" : `(${PP_COSTS.justify} PP)`}
                </button>
                <button onClick={() => handleDiplomacy("guarantee")} className="w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-[#2d3b2d]">🛡 Guarantee ({PP_COSTS.guarantee} PP)</button>
                <button onClick={() => handleDiplomacy("trade")}    className="w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-[#2d3b2d]">💰 Trade Deal</button>
                <button onClick={() => handleDiplomacy("diplomat")} className="w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-[#2d3b2d]">📨 Diplomat ({PP_COSTS.diplomat} PP)</button>
                {isAlly ? (
                  <>
                    <button onClick={() => handleDiplomacy("breakAlliance")} className="w-full px-3 py-1.5 text-left text-sm text-orange-300 hover:bg-[#2d3b2d]">💔 Break Alliance ({PP_COSTS.breakAlliance} PP)</button>
                    <button onClick={() => handleDiplomacy("requestTroops")} className="w-full px-3 py-1.5 text-left text-sm text-cyan-300 hover:bg-[#2d3b2d]">🪖 Request Troops</button>
                  </>
                ) : (
                  <button onClick={() => handleDiplomacy("ally")} className="w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-[#2d3b2d]">🕊 Alliance (rel {ctxCountry.relations.player || 0}/70)</button>
                )}
                <div className="border-t border-[#4a5568] mt-1 pt-1">
                  {atWar ? (
                    <>
                      <button onClick={() => handleDiplomacy("attack")}
                        disabled={!reach.ok}
                        className="w-full px-3 py-1.5 text-left text-sm font-bold hover:bg-[#2d3b2d] disabled:opacity-40">
                        <span className="text-red-400">⚔ Attack</span>
                        {reach.naval && reach.ok && <span className="text-blue-400 ml-1">⚓</span>}
                        {!reach.ok && <span className="text-gray-500 text-xs ml-1">({reach.reason})</span>}
                        {front && reach.ok && <span className="text-orange-300 text-xs ml-1">→ {front.name}</span>}
                        {fallen > 0 && <span className="text-gray-400 text-xs ml-1">({fallen} captured)</span>}
                      </button>
                      <button onClick={() => handleDiplomacy("makePeace")} className="w-full px-3 py-1.5 text-left text-sm text-green-400 hover:bg-[#2d3b2d]">🕊 Make Peace (20 PP)</button>
                    </>
                  ) : (
                    <button onClick={() => handleDiplomacy("declareWar")} disabled={isAlly || !hasGoal}
                      className="w-full px-3 py-1.5 text-left text-sm disabled:text-gray-600 text-red-400 hover:bg-[#2d3b2d]">
                      ⚔ Declare War ({PP_COSTS.declareWar} PP)
                    </button>
                  )}
                </div>
              </>
            );
          })()}
        </div>
      )}

      {/* Inspect panel */}
      {inspecting && inspectCountry && (
        <div className="absolute top-3 right-3 z-30 w-72 bg-[#0f1420]/95 backdrop-blur-md border border-[#4a5568] rounded-xl p-4 max-h-[80vh] overflow-y-auto">
          <div className="flex justify-between items-center mb-3">
            <h3 className="text-white font-bold">{getCountryFlag(inspecting)} {inspectCountry.name}</h3>
            <button onClick={() => setInspecting(null)} className="text-gray-400 hover:text-white">✕</button>
          </div>
          {(() => {
            const mult      = effectiveMult(inspecting!);
            const cityCount = inspectCountry.buildings.filter(b => b.type === "city").length;
            const goldPerSec = ((0.1 + cityCount * 0.05) * mult + inspectCountry.tradeDeals.length * 0.2) * 10;
            const troopsPerSec = 0.2 * mult * 10;
            const ownerId   = inspectCountry.owner;
            const lvls      = ownerId === "player" ? gameState.researchLevels : (ownerId ? gameState.botResearch?.[ownerId] : null);
            const provs     = allProvinces[inspecting!] || [];
            const fallenProvs = provs.filter(p => p.isFallen);
            return (
              <div className="space-y-2 text-sm text-gray-300">
                <div>Owner: <span className="text-white">{inspectCountry.owner ? (inspectCountry.owner === "player" ? "You" : inspectCountry.owner.startsWith("human-") ? `👤 ${humanByOwnerKeyRef.current[inspectCountry.owner]?.name || "Human"}` : gameState.bots.find(b => b.id === inspectCountry.owner)?.name || "AI") : "Unowned"}</span></div>
                {ownerId && gameState.alliances.includes(ownerId) && <div className="text-cyan-400 font-bold">🕊 Allied</div>}
                <div>Troops: <span className="text-white">{Math.floor(inspectCountry.troops).toLocaleString()}</span> <span className="text-green-400 text-xs">+{troopsPerSec.toFixed(1)}/s</span></div>
                <div>Tanks: <span className="text-white">{Math.floor(inspectCountry.tanks)}</span></div>
                <div>Planes: <span className="text-white">{Math.floor(inspectCountry.planes)}</span></div>
                <div>Gold: <span className="text-white">{Math.floor(inspectCountry.gold).toLocaleString()}</span> <span className="text-yellow-400 text-xs">+{goldPerSec.toFixed(1)}/s</span></div>
                <div>Relations: <span className="text-white">{inspectCountry.relations.player || 0}</span></div>
                <div>Buildings: <span className="text-white text-xs">{inspectCountry.buildings.length > 0 ? inspectCountry.buildings.map(b => b.type).join(", ") : "None"}</span></div>
                {provs.length > 0 && (
                  <div className="border-t border-[#4a5568] pt-2">
                    <div className="text-xs text-[#a78bfa] font-bold mb-1">🗺 Provinces ({provs.length})</div>
                    {provs.map(p => (
                      <div key={p.id} className={`text-[11px] mb-0.5 ${p.isFallen ? "text-red-400" : "text-gray-300"}`}>
                        {p.isCapital ? "🏛" : "🗺"} {p.name} · {p.terrainLabel} · {p.stationPercent}%{p.isFallen ? " ⚠FALLEN" : ""}
                      </div>
                    ))}
                    {fallenProvs.length > 0 && <div className="text-[10px] text-red-400 mt-1">{fallenProvs.length} province(s) under occupation</div>}
                  </div>
                )}
                {lvls && (
                  <div className="border-t border-[#4a5568] pt-2">
                    <div className="text-xs text-cyan-400 font-bold mb-1">🔬 Research</div>
                    <div className="grid grid-cols-2 gap-1 text-[10px]">
                      {Object.entries(lvls).map(([k, v]) => (
                        <div key={k}>{k.toUpperCase()}: <span className="text-white">Lv {v as number}</span></div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {/* Notification toast */}
      {notification && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 bg-[#0f1420]/95 border border-[#f97316]/60 rounded-lg px-4 py-2 text-white text-sm font-medium shadow-xl pointer-events-none whitespace-nowrap">
          {notification}
        </div>
      )}

      {/* Hover tooltip */}
      {hoveredCountry && gameState.countries[hoveredCountry] && !contextMenu && !showProvincePanel && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-10 bg-[#0f1420]/80 border border-[#4a5568] rounded-lg px-3 py-1.5 text-xs text-gray-300 pointer-events-none">
          {getCountryFlag(hoveredCountry)} {gameState.countries[hoveredCountry].name}
          {gameState.countries[hoveredCountry].owner === "player" && " · Click to manage provinces"}
          {isAtWar(gameState.wars, hoveredCountry) && " · ⚔ AT WAR"}
        </div>
      )}
    </div>
  );
}
