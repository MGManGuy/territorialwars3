import { useEffect, useRef, useState, useCallback } from "react";
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

// ─── Province System Types ────────────────────────────────────────────────────
interface Province {
  id: string;
  name: string;
  stationPercent: number; // % of country troops stationed here (all provinces sum to 100)
  isCapital: boolean;
  isFallen: boolean;       // true once this province has been captured in battle
  terrainBonus: number;    // extra defensive multiplier 0.0–0.3
  terrainLabel: string;    // e.g. "Mountains", "Plains"
}

const TERRAIN_TYPES = [
  { label: "Plains",    bonus: 0.00 },
  { label: "Hills",     bonus: 0.10 },
  { label: "Forest",    bonus: 0.15 },
  { label: "Mountains", bonus: 0.28 },
  { label: "Desert",    bonus: 0.05 },
  { label: "Coastal",   bonus: 0.05 },
  { label: "Jungle",    bonus: 0.20 },
  { label: "Steppe",    bonus: 0.03 },
];

const PROVINCE_SUFFIX = [
  "Northern Province", "Southern Region", "Eastern Territory",
  "Western Frontier",  "Highland Region", "Coastal Zone",
  "Valley Province",   "Central Plains",  "Border Territory",
  "Forest Region",     "Desert Province", "River Delta",
];

function generateProvinces(countryId: string, countryName: string): Province[] {
  const h = Array.from(countryId).reduce((a, c) => a * 31 + c.charCodeAt(0), 0) >>> 0;
  const count = 3 + (h % 3); // 3, 4, or 5 provinces

  // Capital gets 40 %, remainder split evenly among others
  const capitalPct = 40;
  const otherBase  = Math.floor((100 - capitalPct) / (count - 1));
  const leftover   = 100 - capitalPct - otherBase * (count - 1);

  const provinces: Province[] = [];
  for (let i = 0; i < count; i++) {
    const terrainIdx    = ((h >> (i * 3)) & 0x7) % TERRAIN_TYPES.length;
    const terrain       = TERRAIN_TYPES[terrainIdx];
    const suffixIdx     = ((h >> (i + 4)) % PROVINCE_SUFFIX.length);

    provinces.push({
      id:             `${countryId}-p${i}`,
      name:           i === 0 ? `${countryName} Capital` : `${countryName} ${PROVINCE_SUFFIX[suffixIdx]}`,
      stationPercent: i === 0 ? capitalPct : i === 1 ? otherBase + leftover : otherBase,
      isCapital:      i === 0,
      isFallen:       false,
      terrainBonus:   terrain.bonus,
      terrainLabel:   terrain.label,
    });
  }
  return provinces;
}

/** Returns the province that will be attacked next (weakest non-fallen, non-capital first; capital last). */
function getFrontProvince(provinces: Province[]): Province | null {
  const active = provinces.filter(p => !p.isFallen);
  if (!active.length) return null;
  const nonCapitals = active.filter(p => !p.isCapital);
  if (nonCapitals.length) return nonCapitals.reduce((a, b) => a.stationPercent < b.stationPercent ? a : b);
  return active.find(p => p.isCapital) ?? null;
}

// ─── War / helpers ───────────────────────────────────────────────────────────
function isAtWar(wars: War[], countryId: string): boolean {
  return wars.some(w => w.countryId === countryId);
}
function removeWar(wars: War[], countryId: string): War[] {
  return wars.filter(w => w.countryId !== countryId);
}

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
  const [features,       setFeatures]       = useState<Feature<Geometry>[]>([]);
  const [gameState,      setGameState]      = useState<GameState | null>(null);
  const [selectedBuilding, setSelectedBuilding] = useState<BuildingType | null>(null);
  const [contextMenu,    setContextMenu]    = useState<{ x: number; y: number; countryId: string } | null>(null);
  const [inspecting,     setInspecting]     = useState<string | null>(null);
  const [notification,   setNotification]   = useState<string | null>(null);
  const [showAdvisor,    setShowAdvisor]    = useState(false);
  const [advisorMessages, setAdvisorMessages] = useState<{ role: string; content: string }[]>([]);
  const [advisorInput,   setAdvisorInput]   = useState("");
  const [advisorLoading, setAdvisorLoading] = useState(false);
  const [showFullLeaderboard, setShowFullLeaderboard] = useState(false);
  const [lastTroopRequestYear, setLastTroopRequestYear] = useState(0);
  const [showResearch,   setShowResearch]   = useState(false);
  const [showGoals,      setShowGoals]      = useState(false);
  const [showNotifLog,   setShowNotifLog]   = useState(false);
  const [showFormables,  setShowFormables]  = useState(false);
  const [buildMultiplier, setBuildMultiplier] = useState<1 | 5 | 10>(1);

  // Attack / battle
  const [attackTarget,  setAttackTarget]   = useState<string | null>(null);
  const [attackTroops,  setAttackTroops]   = useState(0);
  const [attackTanks,   setAttackTanks]    = useState(0);
  const [attackPlanes,  setAttackPlanes]   = useState(0);
  const [battle,        setBattle]         = useState<{
    targetId: string;
    provinceId: string;        // ← province system
    isCapitalBattle: boolean;  // ← province system
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
    targetId: string;
    attackerKey: string;
    attackerName: string;
    attacker: number;
    defender: number;
    attackerTanks: number;
    attackerPlanes: number;
    defenderPlanes: number;
    progress: number;
    defenseMult: number;
    forceAttackUntil?: number;
    lastStandUntil?: number;
    updatedAt: number;
  } | null>(null);

  // ── Province state ────────────────────────────────────────────────────────
  const [allProvinces,     setAllProvinces]     = useState<Record<string, Province[]>>({});
  const [showProvincePanel, setShowProvincePanel] = useState<string | null>(null); // countryId
  const allProvincesRef = useRef<Record<string, Province[]>>({});

  // Keep ref in sync
  useEffect(() => { allProvincesRef.current = allProvinces; }, [allProvinces]);

  // Multiplayer
  const gameStateRef      = useRef<GameState | null>(null);
  const featuresRef       = useRef<Feature<Geometry>[]>([]);
  const neighborsRef      = useRef<Record<string, Set<string>>>({});
  const myUserIdRef       = useRef<string | null>(null);
  const myOwnerKeyRef     = useRef<string>("player");
  const myNameRef         = useRef<string>("Player");
  const myColorRef        = useRef<string>(PLAYER_COLOR);
  const mpChannelRef      = useRef<{ broadcast: (e: any) => void; leave: () => void } | null>(null);
  const humanByOwnerKeyRef = useRef<Record<string, { name: string; color: string }>>({});

  const mpBroadcast = useCallback((event: any) => { mpChannelRef.current?.broadcast(event); }, []);
  const ownerIn  = useCallback((o: string | null) => (!o ? null : o === myOwnerKeyRef.current ? "player" : o), []);

  // ── BUG FIX #1: Async IIFE properly invoked, `seed` removed from dep array ──
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

      // ── Generate provinces for every country ──────────────────────────────
      const provinceMap: Record<string, Province[]> = {};
      for (const id of allIds) {
        const c = gs.countries[id];
        if (c) provinceMap[id] = generateProvinces(id, c.name);
      }
      setAllProvinces(provinceMap);
      allProvincesRef.current = provinceMap;
    })(); // ← IIFE properly closed and invoked

    return () => { cancelled = true; };
  }, [playerCountryId, difficulty, lobbyId]); // ← `seed` removed (not in scope)

  // ── Multiplayer realtime sync ──────────────────────────────────────────────
  useEffect(() => {
    if (!lobbyId) return;
    let cancelled = false;
    (async () => {
      const { joinLobbyChannel } = await import("@/game/multiplayerSync");
      if (cancelled) return;
      const ch = joinLobbyChannel(lobbyId, (event) => {
        const ev = event as any;
        const fromLocal       = ownerIn(ev.from);
        const toLocal         = ev.to ? ownerIn(ev.to) : null;
        const newOwnerLocal   = ev.newOwner ? ownerIn(ev.newOwner) : null;
        const fromInfo        = humanByOwnerKeyRef.current[ev.from];
        const fromName        = ev.fromName || fromInfo?.name || "Another player";

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
          showNotif(`🕊 ${fromName} made peace with you.`);
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
            const c   = prev.countries[ev.countryId];
            if (!c)   return prev;
            const wasMine  = c.owner === "player";
            const newOwner = newOwnerLocal!;
            const next     = { ...c, owner: newOwner, color: newOwner === "player" ? PLAYER_COLOR : ev.newOwnerColor, troops: ev.troopsLeft };
            if (wasMine) showNotif(`💀 You LOST ${c.name} to ${fromName}!`);
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

  // ── Draw map ──────────────────────────────────────────────────────────────
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

    const g = svg.select<SVGGElement>("g.map-group");
    g.selectAll("path.country")
      .data(features, (d: any) => d.id)
      .join("path")
      .attr("class",    "country")
      .attr("d",        d => path(d) || "")
      .attr("data-id",  d => d.id as string);

    // Building icons
    const allBuildings: Array<{ key: string; x: number; y: number; icon: string }> = [];
    for (const f of features) {
      const c = gameState.countries[f.id as string];
      if (!c || !c.buildings.length) continue;
      const centroid = path.centroid(f);
      c.buildings.forEach((b, i) => {
        const angle  = i * 2.39996;
        const radius = 6 * Math.sqrt(i);
        const x = (b.x ?? centroid[0]) + (b.x === undefined ? Math.cos(angle) * radius : 0);
        const y = (b.y ?? centroid[1]) + (b.y === undefined ? Math.sin(angle) * radius : 0);
        allBuildings.push({ key: `${f.id}-${i}`, x, y, icon: b.icon });
      });
    }
    g.selectAll("text.building-label")
      .data(allBuildings, (d: any) => d.key)
      .join("text")
      .attr("class", "building-label")
      .attr("text-anchor", "middle").attr("dominant-baseline", "central")
      .attr("font-size", "10px").attr("pointer-events", "none")
      .attr("x", d => d.x).attr("y", d => d.y)
      .text(d => d.icon);

    updateFills(gameState);
  }, [features, gameState]);

  const updateFills = useCallback((gs: GameState) => {
    if (!svgRef.current) return;
    d3.select(svgRef.current)
      .selectAll<SVGPathElement, Feature>("path.country")
      .attr("fill", d => {
        const c = gs.countries[d.id as string];
        if (!c) return "#2d3b2d";
        return c.owner ? c.color + "cc" : c.color || "#5a6b5a";
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

  // ── Economy tick (100ms) ─────────────────────────────────────────────────
  useEffect(() => {
    if (!gameState) return;
    const interval = setInterval(() => {
      setGameState(prev => {
        if (!prev || prev.paused) return prev;
        const newDate   = advanceDate(prev.date, prev.speed);
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
          const mult   = effectiveMult(cid) * (isBot ? aiBuff : playerNerf);

          const cityCount      = c.buildings.filter(b => b.type === "city").length;
          const barracksCount  = c.buildings.filter(b => b.type === "barracks").length;
          const factoryCount   = c.buildings.filter(b => b.type === "factory").length;
          const courthouseCount= c.buildings.filter(b => b.type === "courthouse").length;
          const airbaseCount   = c.buildings.filter(b => b.type === "airbase").length;

          const goldGain  = (0.1 + cityCount * 0.05) * mult;
          const troopGain = (0.2 + barracksCount * 0.02) * mult;
          const tankGain  = factoryCount * 0.1 * (isBot ? aiBuff : playerNerf);
          const planeGain = airbaseCount * 0.1 * (isBot ? aiBuff : playerNerf);
          const airUpkeep = airbaseCount * 0.2;
          const tradeBonus = c.tradeDeals.length * 0.2;
          if (c.tradeDeals.includes("player") && c.owner !== "player") playerGoldBonusFromTrade += 0.2;

          let newGold     = Math.max(0, c.gold + goldGain + tradeBonus - airUpkeep);
          let newBuildings= c.buildings;

          let newRelations   = c.relations;
          let newDiplomatUntil = c.diplomatUntil;
          if (c.diplomatUntil && now < c.diplomatUntil) {
            newRelations = { ...c.relations, player: (c.relations.player || 0) + 0.1 };
          }
          if (c.diplomatUntil && now >= c.diplomatUntil) newDiplomatUntil = undefined;

          // AI building logic
          if (c.owner && c.owner !== "player" && !c.owner.startsWith("human-")) {
            const totalBuilt    = c.buildings.length;
            const fortCount     = c.buildings.filter(b => b.type === "fort").length;
            const portCount     = c.buildings.filter(b => b.type === "port").length;
            const isRichMajor   = !!(COUNTRY_ECON_MULT[cid] && COUNTRY_ECON_MULT[cid] >= 3.0);
            const nbsSet        = neighborsRef.current[cid];
            const isIsland      = c.isCoastal !== false && (!nbsSet || nbsSet.size === 0);
            const isTargetOfPlayer = prev.wars.some(w => w.countryId === cid);

            let nextType: BuildingType = "city";
            if (isTargetOfPlayer && fortCount < 5)                                  nextType = "fort";
            else if (cityCount      < (isRichMajor ? 8 : 5))                        nextType = "city";
            else if (barracksCount  < (isRichMajor ? 4 : 3))                        nextType = "barracks";
            else if (factoryCount   < (isRichMajor ? 3 : 2))                        nextType = "factory";
            else if (courthouseCount < 1)                                            nextType = "courthouse";
            else if (totalBuilt >= (isRichMajor ? 5 : 10) && airbaseCount < (isRichMajor ? 4 : 1)) nextType = "airbase";
            else if (isIsland && portCount < 1)                                     nextType = "port";
            else                                                                     nextType = "city";

            const def = BUILDING_DEFS[nextType];
            if (newGold >= def.cost && totalBuilt < 25) {
              newGold      -= def.cost;
              newBuildings  = [...newBuildings, { type: nextType, icon: def.icon }];
            }
          }

          if (c.owner === "player") {
            playerTanksGain   += tankGain;
            playerPlanesGain  += planeGain;
            playerCourthousePP += courthouseCount * 0.05;
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
            setTimeout(() => showNotif(`🏆 Goal completed: ${goal.label}! +${goal.reward} PP`), 0);
          }
        }

        const next = {
          ...prev,
          gold:           prev.gold + ((goldRate / 10) * goldMult + playerGoldBonusFromTrade) * playerNerf,
          troops:         prev.troops + (troopRate / 10) * troopMult * playerNerf,
          tanks:          prev.tanks  + playerTanksGain,
          planes:         prev.planes + playerPlanesGain,
          politicalPower: prev.politicalPower + (ppRate / 10 + playerCourthousePP) * playerNerf + goalReward,
          date: newDate, countries: newCountries, researchLevels, activeResearch, completedGoals,
        };
        gameStateRef.current = next;
        return next;
      });
    }, 100);
    return () => clearInterval(interval);
  }, [gameState?.paused, gameState?.speed, difficulty]);

  // ── Battle tick (250ms) ──────────────────────────────────────────────────
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

        const atkEff   = b.attacker + b.attackerTanks * 10;
        const rl       = gameStateRef.current?.researchLevels || {};
        const atkRes   = 1 + ((rl.atk || 0) * 0.1);
        const defRes   = 1 + ((rl.def || 0) * 0.1);

        const defCountry     = gameStateRef.current?.countries[b.targetId];
        const courthouseBonus= defCountry ? 1 + defCountry.buildings.filter(b2 => b2.type === "courthouse").length * 0.20 : 1;

        // Province terrain bonus applied here
        const prov       = allProvincesRef.current[b.targetId]?.find(p => p.id === b.provinceId);
        const terrainMlt = prov ? 1 + prov.terrainBonus : 1;

        let defMult = b.defenseMult * defRes * airBonusDef * courthouseBonus * terrainMlt;
        if (isLast)   defMult *= 2;
        if (isAiLast) defMult *= 2;

        const atkPower = (isForce ? 1.5 : 1) * atkRes * airBonusAtk;
        const ratio    = atkEff / Math.max(1, b.defender);

        const atkLoss  = Math.ceil(b.attacker    * 0.010 * defMult / Math.max(0.5, Math.sqrt(ratio)) * (0.8 + Math.random() * 0.4) * (isForce ? 1.2 : 1));
        const defLoss  = Math.ceil(b.defender    * 0.010 * Math.sqrt(ratio) / defMult * (0.8 + Math.random() * 0.4) * atkPower * (isLast ? 1.35 : 1));
        const tankLoss = Math.ceil(b.attackerTanks  * 0.008 * (isForce ? 1.2 : 1));
        const atkPLoss = Math.ceil(b.attackerPlanes * 0.005);
        const defPLoss = Math.ceil(b.defenderPlanes * 0.005);

        const newAtk  = Math.max(0, b.attacker    - atkLoss);
        const newDef  = Math.max(0, b.defender    - defLoss);
        const newATk  = Math.max(0, b.attackerTanks  - tankLoss);
        const newAP   = Math.max(0, b.attackerPlanes - atkPLoss);
        const newDP   = Math.max(0, b.defenderPlanes - defPLoss);
        const progress= Math.min(100, b.progress + Math.max(0.2, Math.min(3, ratio * 0.8)) * (isForce ? 1.5 : 1));
        const stale   = progress >= 100 && newAtk > 100 && newDef > 100 && Math.abs(ratio - 1) < 0.15;

        if (newAtk <= 0 || newDef <= 0 || stale) {
          // ── Province-aware battle resolution ─────────────────────────────
          setGameState(prev => {
            if (!prev) return prev;
            const target   = { ...prev.countries[b.targetId] };
            target.planes  = Math.max(0, target.planes - (b.defenderPlanes - newDP));
            const newCountries = { ...prev.countries, [b.targetId]: target };
            let newTroops  = prev.troops + newAtk;
            let newTanks   = prev.tanks  + newATk;
            let newPlanes  = prev.planes + newAP;
            let newGold    = prev.gold;
            let newWars    = prev.wars;

            if (newDef <= 0 && newAtk > 0) {
              if (!b.isCapitalBattle) {
                // ── Province captured (not whole country yet) ─────────────
                // Reduce country troops by the province's contribution
                const provPct = (allProvincesRef.current[b.targetId]?.find(p => p.id === b.provinceId)?.stationPercent || 0) / 100;
                const troopsLost = Math.floor(target.troops * provPct);
                target.troops = Math.max(0, target.troops - troopsLost);
                newCountries[b.targetId] = target;

                // Mark province as fallen
                setAllProvinces(ap => {
                  const provs = (ap[b.targetId] || []).map(p =>
                    p.id === b.provinceId ? { ...p, isFallen: true, stationPercent: 0 } : p
                  );
                  // Redistribute fallen province % to remaining active provinces
                  const active  = provs.filter(p => !p.isFallen);
                  const rescued = provPct * 100;
                  if (active.length > 0) {
                    const share = Math.floor(rescued / active.length);
                    const bonusIdx = 0;
                    return {
                      ...ap, [b.targetId]: provs.map((p, i) =>
                        p.isFallen ? p : { ...p, stationPercent: p.stationPercent + share + (i === bonusIdx ? rescued % active.length : 0) }
                      ),
                    };
                  }
                  return { ...ap, [b.targetId]: provs };
                });

                setTimeout(() => showNotif(`⚔ Province captured! Advance toward ${target.name}'s capital.`), 0);
              } else {
                // ── Capital captured — full country conquest ──────────────
                const previousOwner = target.owner;
                const looted = Math.floor(target.gold);
                newGold     += looted;
                target.gold  = 0;
                target.owner = "player";
                target.color = PLAYER_COLOR;
                target.troops= Math.max(50, Math.floor(newAtk * 0.5));
                newTroops   -= target.troops;
                newCountries[b.targetId] = target;
                newWars = removeWar(prev.wars, b.targetId);

                // Reset provinces for newly captured country
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
              setTimeout(() => showNotif(`💀 Attack on ${target.name} failed — your forces were destroyed.`), 0);
            } else {
              setTimeout(() => showNotif(`🛑 Battle for ${target.name} ended in stalemate.`), 0);
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

  // ── BUG FIX #3: Bot counter-attack — was re-registering on `gameState?.playerId`
  //    (never changes) which meant `paused` wasn't re-checked properly.
  //    Reads from gameStateRef so deps can be [].
  useEffect(() => {
    const iv = setInterval(() => {
      const prev = gameStateRef.current;
      if (!prev || prev.paused) return;
      const now  = Date.now();
      if (!prev.wars.length) return;
      const updates: { war: War; damage: number; enemyName: string }[] = [];
      for (const w of prev.wars) {
        if (now - w.startedAt < 60000) continue;
        if (w.lastBotAttack && now - w.lastBotAttack < 20000) continue;
        const enemy = prev.countries[w.countryId];
        if (!enemy?.owner || enemy.owner === "player" || enemy.owner.startsWith("human-")) continue;
        const botForce = Math.floor(enemy.troops * 0.25);
        const damage   = Math.max(20, Math.floor(botForce * 0.25));
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
      for (const u of updates) showNotif(`⚠️ ${u.enemyName} counter-attacks! You lose ${u.damage} troops!`);
    }, 2000);
    return () => clearInterval(iv);
  }, []); // ← empty: reads gameStateRef, not reactive state

  // ── Bot research + AI wars + trade offers (3s) — also fixed dep ──────────
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

        // Bot research
        for (const bot of p.bots) {
          const owned = Object.values(countries).filter(c => c.owner === bot.id);
          if (!owned.length || p.date.year < 2026) continue;
          const richest = owned.reduce((a, b) => a.gold > b.gold ? a : b);
          if (richest.gold > 60) {
            countries[richest.id] = { ...richest, gold: richest.gold - 5 };
            botSavings[bot.id]    = (botSavings[bot.id] || 0) + 5;
          }
          const lvls  = botResearch[bot.id] || { atk: 0, def: 0, gold: 0, troop: 0 };
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

        // AI trade offers
        const playerContinent = CONTINENTS[p.playerCountryId];
        for (const cid in countries) {
          const c = countries[cid];
          if (!c.owner || c.owner === "player" || CONTINENTS[cid] !== playerContinent) continue;
          if (c.tradeDeals.includes("player")) continue;
          if ((c.relations.player || 0) < 30 || Math.random() >= 0.02) continue;
          countries[cid] = { ...c, tradeDeals: [...c.tradeDeals, "player"] };
          notifs.push(`💰 ${c.name} offered a trade deal — accepted! +2 gold/sec`);
        }

        // Bot vs bot wars
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
                const force = Math.floor(c.troops * 0.75);
                const defMlt= 1 + nb.buildings.filter(b => b.type === "fort").length * 0.02;
                const atkPow= force * (1 + ((botResearch[ag.id]?.atk || 0) * 0.1));
                const defPow= nb.troops * defMlt * (1 + ((botResearch[nb.owner]?.def || 0) * 0.1));
                countries[agRichest.id] = { ...countries[agRichest.id], gold: agRichest.gold - 100 };
                countries[c.id]         = { ...countries[c.id], troops: Math.max(50, c.troops - Math.floor(force * 0.5)) };
                if (atkPow > defPow) {
                  const looted = Math.floor(nb.gold);
                  countries[c.id] = { ...countries[c.id], gold: countries[c.id].gold + looted };
                  countries[nbId] = { ...nb, owner: ag.id, color: ag.color, gold: 0, troops: Math.max(50, Math.floor(force * 0.3)) };
                  notifs.push(`⚔ ${ag.name} conquered ${nb.name}!`);
                  if (p.guarantees?.includes(nbId) && !wars.some(w => w.countryId === agCountries[0]?.id)) {
                    wars = [...wars, { countryId: agCountries[0].id, startedAt: now }];
                    notifs.push(`🛡 You guaranteed ${nb.name} — dragged into war with ${ag.name}!`);
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
  }, []); // ← empty: reads gameStateRef

  // ── BUG FIX #2: WASD — removed `.transition().duration(0)` wrapper ────────
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
      if (e.key === "Escape") { setSelectedBuilding(null); setContextMenu(null); setInspecting(null); setShowProvincePanel(null); }
    };
    const onKeyUp   = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase());
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
          if (dx !== 0 || dy !== 0) {
            // Direct call — NO `.transition().duration(0)` wrapper (that was the bug)
            d3.select(svgRef.current).call(zoom.translateBy, dx, dy);
          }
        }
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("keyup", onKeyUp); cancelAnimationFrame(frame); };
  }, []);

  // ── Notification helper ───────────────────────────────────────────────────
  const showNotif = useCallback((msg: string) => {
    setNotification(msg);
    setTimeout(() => setNotification(null), 2500);
    setGameState(prev => {
      if (!prev) return prev;
      const entry = { id: Date.now() + Math.random(), message: msg, timestamp: Date.now() };
      return { ...prev, notifications: [entry, ...prev.notifications].slice(0, 100) };
    });
  }, []);

  // ── Click handler ─────────────────────────────────────────────────────────
  const handleClick = useCallback((e: React.MouseEvent) => {
    if (contextMenu) { setContextMenu(null); return; }
    const target = (e.target as SVGElement).closest("path.country");
    if (!target || !gameState) return;
    const id      = target.getAttribute("data-id") || "";
    const country = gameState.countries[id];
    if (!country) return;

    if (country.owner === "player" && !selectedBuilding) {
      // Open province panel for owned country
      setShowProvincePanel(prev => prev === id ? null : id);
      setInspecting(null);
      return;
    }

    if (selectedBuilding && country.owner === "player") {
      const def       = BUILDING_DEFS[selectedBuilding];
      if (def.requiresCoast && country.isCoastal === false) { showNotif(`${def.label} requires a coastal country!`); return; }
      const totalCost = def.cost * buildMultiplier;
      if (gameState.gold < totalCost) { showNotif(`Not enough gold! Need ${totalCost} for ×${buildMultiplier}`); return; }
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
      showNotif(`${def.icon} ×${buildMultiplier} ${def.label} placed in ${country.name}!`);
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

  // ── Province panel actions ────────────────────────────────────────────────
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

  // PP cost map
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
      if (gameState.politicalPower < cost) { showNotif(`Not enough Political Power! Need ${cost} PP`); setContextMenu(null); return; }
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
        showNotif(`Relations improved with ${c.name} (+10) — −${PP_COSTS.improve} PP`);
        break;
      case "trade":
        if (gameState.gold < 50) { showNotif("Need 50 gold for trade deal!"); break; }
        setGameState(prev => {
          if (!prev) return prev;
          const country = { ...prev.countries[contextMenu.countryId] };
          if (country.tradeDeals.includes("player")) { showNotif("Already have trade deal!"); return prev; }
          country.tradeDeals = [...country.tradeDeals, "player"];
          return { ...prev, gold: prev.gold - 50, politicalPower: prev.politicalPower - PP_COSTS.trade, countries: { ...prev.countries, [contextMenu.countryId]: country } };
        });
        showNotif(`Trade deal with ${c.name}! +2 gold/sec — −${PP_COSTS.trade} PP`);
        break;
      case "guarantee":
        setGameState(prev => prev ? { ...prev, politicalPower: prev.politicalPower - PP_COSTS.guarantee, guarantees: prev.guarantees?.includes(contextMenu.countryId) ? prev.guarantees : [...(prev.guarantees || []), contextMenu.countryId] } : prev);
        showNotif(`🛡 Guaranteed independence of ${c.name} — −${PP_COSTS.guarantee} PP.`);
        break;
      case "diplomat":
        setGameState(prev => {
          if (!prev) return prev;
          const country = { ...prev.countries[contextMenu.countryId], diplomatUntil: Date.now() + 100000 };
          return { ...prev, politicalPower: prev.politicalPower - PP_COSTS.diplomat, countries: { ...prev.countries, [contextMenu.countryId]: country } };
        });
        showNotif(`📨 Diplomat sent to ${c.name}: +1 rel/sec for 100s — −${PP_COSTS.diplomat} PP`);
        break;
      case "ally": {
        const ownerId = c.owner;
        if (!ownerId) { showNotif(`${c.name} is unowned.`); break; }
        setGameState(prev => {
          if (!prev) return prev;
          const rel = prev.countries[contextMenu.countryId]?.relations?.player || 0;
          if (rel < 70) { showNotif(`❌ ${c.name} rejected alliance. Need 70+ (current: ${rel})`); return prev; }
          if (prev.alliances.includes(ownerId)) return prev;
          showNotif(`✅ ${c.name} accepted alliance! — −${PP_COSTS.ally} PP`);
          return { ...prev, politicalPower: prev.politicalPower - PP_COSTS.ally, alliances: [...prev.alliances, ownerId] };
        });
        break;
      }
      case "breakAlliance": {
        const ownerId = c.owner;
        if (!ownerId || !gameState.alliances.includes(ownerId)) { showNotif(`Not allied with ${c.name}.`); break; }
        setGameState(prev => prev ? { ...prev, politicalPower: prev.politicalPower - PP_COSTS.breakAlliance, alliances: prev.alliances.filter(a => a !== ownerId) } : prev);
        showNotif(`💔 Alliance with ${c.name} broken — −${PP_COSTS.breakAlliance} PP`);
        break;
      }
      case "justify":
        if (gameState.warGoals.includes(contextMenu.countryId)) { showNotif(`War goal already justified.`); break; }
        if (c.owner && gameState.alliances.includes(c.owner)) { showNotif(`Cannot justify war on an ally.`); break; }
        setGameState(prev => {
          if (!prev) return prev;
          const country = { ...prev.countries[contextMenu.countryId] };
          country.relations = { ...country.relations, player: (country.relations.player || 0) - 20 };
          return { ...prev, politicalPower: prev.politicalPower - PP_COSTS.justify, warGoals: [...prev.warGoals, contextMenu.countryId], countries: { ...prev.countries, [contextMenu.countryId]: country } };
        });
        showNotif(`📜 War goal justified on ${c.name} (−20 relations) — −${PP_COSTS.justify} PP`);
        break;
      case "declareWar":
        if (c.owner && gameState.alliances.includes(c.owner)) { showNotif(`Cannot declare war on an ally.`); break; }
        if (!gameState.warGoals.includes(contextMenu.countryId)) { showNotif(`Justify a war goal first!`); break; }
        if (isAtWar(gameState.wars, contextMenu.countryId)) { showNotif(`Already at war.`); break; }
        setGameState(prev => {
          if (!prev) return prev;
          const country = { ...prev.countries[contextMenu.countryId] };
          country.relations = { ...country.relations, player: (country.relations.player || 0) - 80 };
          return { ...prev, politicalPower: prev.politicalPower - PP_COSTS.declareWar, wars: [...prev.wars, { countryId: contextMenu.countryId, startedAt: Date.now() }], countries: { ...prev.countries, [contextMenu.countryId]: country } };
        });
        if (c.owner?.startsWith("human-")) mpBroadcast({ type: "war_declared", from: myOwnerKeyRef.current, fromName: myNameRef.current, to: c.owner, targetCountryId: contextMenu.countryId });
        showNotif(`⚔ WAR DECLARED on ${c.name}! — −${PP_COSTS.declareWar} PP`);
        break;
      case "attack": {
        if (!isAtWar(gameState.wars, contextMenu.countryId)) { showNotif(`Not at war with ${c.name}.`); break; }
        setAttackTarget(contextMenu.countryId);
        setAttackTroops(Math.min(Math.floor(gameState.troops), Math.max(100, Math.floor(gameState.troops / 2))));
        setAttackTanks(Math.floor(gameState.tanks));
        setAttackPlanes(Math.floor(gameState.planes));
        break;
      }
      case "makePeace":
        if (!isAtWar(gameState.wars, contextMenu.countryId)) { showNotif(`Not at war.`); break; }
        setGameState(prev => {
          if (!prev) return prev;
          const country = { ...prev.countries[contextMenu.countryId] };
          country.relations = { ...country.relations, player: Math.min((country.relations.player || 0) + 30, 0) };
          return { ...prev, politicalPower: prev.politicalPower - 20, wars: removeWar(prev.wars, contextMenu.countryId), warGoals: prev.warGoals.filter(w => w !== contextMenu.countryId), countries: { ...prev.countries, [contextMenu.countryId]: country } };
        });
        // Reset fallen provinces when peace is made
        setAllProvinces(ap => ({ ...ap, [contextMenu.countryId]: generateProvinces(contextMenu.countryId, c.name) }));
        if (c.owner?.startsWith("human-")) mpBroadcast({ type: "war_ended", from: myOwnerKeyRef.current, fromName: myNameRef.current, to: c.owner, targetCountryId: contextMenu.countryId });
        showNotif(`🕊 Peace made with ${c.name}! −20 PP`);
        break;
      case "requestTroops": {
        const ownerId = c.owner;
        if (!ownerId || !gameState.alliances.includes(ownerId)) { showNotif(`${c.name} is not your ally.`); break; }
        if (lastTroopRequestYear >= gameState.date.year) { showNotif(`Can only request troops once per year!`); break; }
        const rel   = c.relations.player || 0;
        const chance= Math.min(0.9, Math.max(0.1, rel / 220));
        const roll  = Math.random();
        if (roll < chance) {
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
          showNotif(`❌ ${c.name} refused to send troops.`);
        }
        break;
      }
    }
    setContextMenu(null);
  }, [contextMenu, gameState, showNotif, lastTroopRequestYear, mpBroadcast]);

  // ── AI Advisor ────────────────────────────────────────────────────────────
  const sendAdvisorMsg = async () => {
    if (!advisorInput.trim() || !gameState) return;
    const userMsg = { role: "user", content: advisorInput };
    setAdvisorMessages(p => [...p, userMsg]);
    setAdvisorInput("");
    setAdvisorLoading(true);
    const playerCountries = Object.values(gameState.countries).filter(c => c.owner === "player");
    const gameContext = { date: formatDate(gameState.date), playerCountry: getCountryName(gameState.playerCountryId), gold: Math.floor(gameState.gold), troops: Math.floor(gameState.troops), buildings: playerCountries.flatMap(c => c.buildings.map(b => b.type)), ownedCountries: playerCountries.map(c => c.name) };
    try {
      const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/strategy-advisor`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}` }, body: JSON.stringify({ messages: [...advisorMessages, userMsg], gameState: gameContext }) });
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
    } catch { setAdvisorMessages(p => [...p, { role: "assistant", content: "Sorry, advisor unavailable." }]); }
    setAdvisorLoading(false);
  };

  // ─── Early return ──────────────────────────────────────────────────────────
  if (!gameState) return <div className="w-full h-full flex items-center justify-center text-white bg-[#0f1420]">Loading map data…</div>;

  const leaderboard        = getLeaderboard(gameState);
  const visibleLeaderboard = showFullLeaderboard ? leaderboard : leaderboard.slice(0, 4);
  const playerEntry        = leaderboard.find(l => l.id === "player");
  const goldRate           = getGoldRate(gameState);
  const troopRate          = getTroopRate(gameState);
  const ppRate             = getPoliticalPowerRate(gameState);
  const inspectCountry     = inspecting ? gameState.countries[inspecting] : null;
  const ctxCountry         = contextMenu ? gameState.countries[contextMenu.countryId] : null;
  const provincePanelCountry = showProvincePanel ? gameState.countries[showProvincePanel] : null;
  const provincePanelData    = showProvincePanel ? (allProvinces[showProvincePanel] || []) : [];

  // Province troops: countryTroops * stationPercent/100
  const getTroopsInProvince = (countryId: string, prov: Province) =>
    Math.floor((gameState.countries[countryId]?.troops || 0) * prov.stationPercent / 100);

  return (
    <div className="relative w-full h-full" onClick={() => { if (contextMenu) setContextMenu(null); }}>
      {/* Map SVG */}
      <svg ref={svgRef} width="100%" height="100%" className="bg-[#1a1f2e]"
        onClick={handleClick} onContextMenu={handleContextMenu}
        style={{ cursor: selectedBuilding ? "crosshair" : "grab" }}>
        <g className="map-group" />
      </svg>

      {/* Vignette */}
      <div className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.4) 100%)" }} />

      {/* Date / speed — top center */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 bg-[#0f1420]/90 backdrop-blur-sm px-4 py-2 rounded-full border border-[#4a5568]">
        <button onClick={() => setGameState(p => p ? { ...p, speed: Math.max(1, p.speed - 1) } : p)} className="text-gray-400 hover:text-white px-1">◀</button>
        <button onClick={() => setGameState(p => p ? { ...p, paused: !p.paused } : p)} className="text-white hover:text-[#f97316] px-1 text-lg">{gameState.paused ? "▶" : "⏸"}</button>
        <span className="text-white font-mono text-sm min-w-[160px] text-center">{formatDate(gameState.date)}</span>
        <span className="text-[#f97316] text-xs">×{gameState.speed}</span>
        <button onClick={() => setGameState(p => p ? { ...p, speed: Math.min(5, p.speed + 1) } : p)} className="text-gray-400 hover:text-white px-1">▶</button>
      </div>

      {/* Leaderboard — top left */}
      <div className="absolute top-3 left-3 z-20 bg-[#0f1420]/90 backdrop-blur-sm rounded-lg border border-[#4a5568] p-3 min-w-[280px]">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs text-gray-400 font-bold uppercase tracking-wider">Leaderboard</div>
          <button onClick={() => setShowFullLeaderboard(v => !v)} className="text-[10px] text-[#f97316] hover:text-[#fb923c] font-semibold uppercase tracking-wider">
            {showFullLeaderboard ? "Show less ▲" : `Show more (${leaderboard.length}) ▼`}
          </button>
        </div>
        <div className={showFullLeaderboard ? "max-h-[320px] overflow-y-auto pr-1" : ""} style={showFullLeaderboard ? { scrollbarWidth: "thin" } : undefined}>
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-[#0f1420]">
              <tr className="text-gray-500"><th className="text-left w-6">#</th><th className="text-left">Country</th><th className="text-right">Gold</th><th className="text-right">Troops</th></tr>
            </thead>
            <tbody>
              {visibleLeaderboard.map(entry => (
                <tr key={entry.id} className={entry.id === "player" ? "text-[#a78bfa]" : "text-gray-300"}>
                  <td>{entry.rank}</td>
                  <td className="flex items-center gap-1"><span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: entry.color }} /><span className="truncate max-w-[120px]">{entry.name}</span></td>
                  <td className="text-right">{Math.floor(entry.gold)}</td>
                  <td className="text-right">{Math.floor(entry.troops)}</td>
                </tr>
              ))}
              {!showFullLeaderboard && playerEntry && !visibleLeaderboard.some(t => t.id === "player") && (
                <tr className="text-[#a78bfa] border-t border-[#4a5568]">
                  <td>{playerEntry.rank}</td>
                  <td className="flex items-center gap-1"><span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: PLAYER_COLOR }} />You</td>
                  <td className="text-right">{Math.floor(playerEntry.gold)}</td>
                  <td className="text-right">{Math.floor(playerEntry.troops)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Stats — bottom left */}
      <div className="absolute bottom-20 left-3 z-20 bg-[#0f1420]/90 backdrop-blur-sm rounded-lg border border-[#4a5568] p-3 min-w-[220px]">
        <div className="text-sm text-white mb-1">⚔ Troops: <span className="font-bold">{Math.floor(gameState.troops)}</span><span className="text-green-400 text-xs ml-1">+{troopRate}/s</span></div>
        <div className="text-sm text-white mb-1">🚜 Tanks: <span className="font-bold">{Math.floor(gameState.tanks)}</span></div>
        <div className="text-sm text-white mb-1">✈ Planes: <span className="font-bold">{Math.floor(gameState.planes)}</span></div>
        <div className="text-sm text-white mb-1">💰 Gold: <span className="font-bold">{Math.floor(gameState.gold)}</span><span className="text-green-400 text-xs ml-1">+{goldRate}/s</span></div>
        <div className="text-sm text-white">🎖 PP: <span className="font-bold">{Math.floor(gameState.politicalPower)}</span><span className="text-green-400 text-xs ml-1">+{ppRate.toFixed(1)}/s</span></div>
      </div>

      {/* Allies */}
      {gameState.alliances.length > 0 && (
        <div className="absolute bottom-3 left-3 z-20 bg-[#0f1420]/90 backdrop-blur-sm rounded-lg border border-cyan-500/50 p-2 min-w-[220px] max-h-[120px] overflow-y-auto">
          <div className="text-xs text-cyan-400 mb-1 font-bold uppercase tracking-wider">🕊 Allies ({gameState.alliances.length})</div>
          {gameState.alliances.map(allyId => {
            const bot = gameState.bots.find(b => b.id === allyId);
            return bot ? (
              <div key={allyId} className="flex items-center gap-2 text-xs text-gray-200">
                <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: bot.color }} />
                <span className="truncate">{bot.name}</span>
              </div>
            ) : null;
          })}
        </div>
      )}

      {/* Hotbar — bottom center */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 flex items-end gap-2">
        <div className="flex gap-1">
          {BUILDING_SLOTS.map((bt, i) => {
            const def = BUILDING_DEFS[bt];
            const isSelected = selectedBuilding === bt;
            return (
              <button key={bt} onClick={e => { e.stopPropagation(); setSelectedBuilding(isSelected ? null : bt); }}
                className={`w-14 h-14 rounded-lg flex flex-col items-center justify-center text-xs transition border ${isSelected ? "bg-[#7c3aed] border-[#a78bfa] text-white" : "bg-[#0f1420]/90 border-[#4a5568] text-gray-300 hover:bg-[#1a2030]"}`}
                title={`${def.label} — ${def.cost * buildMultiplier} gold (×${buildMultiplier}) — ${def.description}`}>
                <span className="text-lg">{def.icon}</span>
                <span className="text-[10px]">{i + 1}</span>
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

      {/* Side rail — right */}
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

      {/* Exit button */}
      <div className="absolute top-3 right-3 z-20">
        <button onClick={onExit} className="px-3 py-1.5 rounded-lg bg-[#0f1420]/90 border border-[#4a5568] text-gray-300 hover:text-white hover:bg-[#1a2030] text-xs font-bold transition">✕ Exit</button>
      </div>

      {/* ── Province Panel ─────────────────────────────────────────────────── */}
      {showProvincePanel && provincePanelCountry && (
        <div className="absolute top-3 right-3 z-30 w-80 bg-[#0f1420]/95 border border-[#a78bfa]/60 rounded-xl p-4 max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
          <div className="flex justify-between items-center mb-3">
            <h3 className="text-white font-bold text-sm">🗺 {provincePanelCountry.name} — Provinces</h3>
            <button onClick={() => setShowProvincePanel(null)} className="text-gray-400 hover:text-white">✕</button>
          </div>
          <div className="text-[10px] text-gray-400 mb-2">
            Total troops: <span className="text-white font-bold">{Math.floor(provincePanelCountry.troops)}</span>
            <br/>Click ← → to redistribute troops between provinces (min 10%).
          </div>
          <div className="text-[10px] text-gray-400 mb-3">
            💡 Attack a province to capture it before its capital for a multi-stage invasion.
          </div>
          <div className="space-y-2">
            {provincePanelData.map((prov, idx) => {
              const troopsHere = getTroopsInProvince(showProvincePanel!, prov);
              const isFront    = !prov.isCapital && !prov.isFallen &&
                provincePanelData.filter(p => !p.isFallen && !p.isCapital).sort((a,b) => a.stationPercent - b.stationPercent)[0]?.id === prov.id;
              return (
                <div key={prov.id} className={`p-2.5 rounded-lg border text-xs ${
                  prov.isFallen  ? "border-red-500/40 bg-red-900/10 opacity-60" :
                  prov.isCapital ? "border-yellow-400/50 bg-yellow-900/10" :
                  isFront        ? "border-orange-400/50 bg-orange-900/10" :
                                   "border-[#4a5568] bg-[#1a2030]"
                }`}>
                  <div className="flex justify-between items-start mb-1">
                    <div>
                      <span className="text-white font-bold">{prov.isCapital ? "🏛" : isFront ? "⚔" : "🗺"} {prov.name}</span>
                      {prov.isFallen && <span className="text-red-400 ml-1">FALLEN</span>}
                      {isFront && !prov.isFallen && <span className="text-orange-400 ml-1 text-[9px]">FRONT</span>}
                    </div>
                    <span className="text-gray-500 text-[10px]">{prov.terrainLabel}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <div>
                      <div className="text-green-400">{Math.floor(troopsHere).toLocaleString()} troops ({prov.stationPercent}%)</div>
                      <div className="text-cyan-400 text-[10px]">Terrain defense: +{Math.round(prov.terrainBonus * 100)}%</div>
                    </div>
                    {!prov.isFallen && (
                      <div className="flex gap-1">
                        {/* Move troops FROM this province to prev */}
                        {idx > 0 && !provincePanelData[idx - 1]?.isFallen && prov.stationPercent > 10 && (
                          <button onClick={() => moveProvincePercent(showProvincePanel!, idx, idx - 1, 10)}
                            className="w-6 h-6 rounded bg-[#2d3b2d] border border-[#4a5568] text-white hover:bg-[#3d4b3d] flex items-center justify-center" title="Move 10% up">↑</button>
                        )}
                        {/* Move troops FROM this province to next */}
                        {idx < provincePanelData.length - 1 && !provincePanelData[idx + 1]?.isFallen && prov.stationPercent > 10 && (
                          <button onClick={() => moveProvincePercent(showProvincePanel!, idx, idx + 1, 10)}
                            className="w-6 h-6 rounded bg-[#2d3b2d] border border-[#4a5568] text-white hover:bg-[#3d4b3d] flex items-center justify-center" title="Move 10% down">↓</button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-3 p-2 bg-[#1a2030] rounded text-[10px] text-gray-400">
            <div className="text-cyan-400 font-bold mb-1">📋 Province Legend</div>
            <div>🏛 Capital — captured last, hardest to defend</div>
            <div>⚔ Front — currently the weakest border province</div>
            <div>🗺 Province — inner territory</div>
          </div>
        </div>
      )}

      {/* ── Attack modal ─────────────────────────────────────────────────── */}
      {attackTarget && !battle && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 pointer-events-auto" onClick={() => setAttackTarget(null)}>
          <div className="bg-[#0f1420] border border-red-500/60 rounded-xl p-6 w-96 shadow-2xl" onClick={e => e.stopPropagation()}>
            {(() => {
              const tc    = gameState.countries[attackTarget];
              const provs = allProvinces[attackTarget] || [];
              const front = getFrontProvince(provs);
              const isCapitalbattle = !provs.some(p => !p.isFallen && !p.isCapital);
              return (
                <>
                  <h3 className="text-white font-bold text-lg mb-1">⚔ Attack {tc?.name}</h3>
                  {front && (
                    <div className={`mb-3 p-2 rounded text-xs ${isCapitalbattle ? "bg-yellow-900/30 border border-yellow-400/50 text-yellow-300" : "bg-orange-900/20 border border-orange-400/40 text-orange-300"}`}>
                      Target Province: <span className="font-bold">{front.name}</span>
                      <br/>Terrain: {front.terrainLabel} (+{Math.round(front.terrainBonus * 100)}% defense)
                      {isCapitalbattle && <div className="text-yellow-400 font-bold mt-0.5">⚠ Capital assault — victory captures the country!</div>}
                    </div>
                  )}
                  <div className="space-y-3">
                    <div>
                      <label className="text-xs text-gray-400">Troops to send: <span className="text-white font-bold">{attackTroops.toLocaleString()}</span></label>
                      <input type="range" min={1} max={Math.floor(gameState.troops)} value={attackTroops} onChange={e => setAttackTroops(+e.target.value)}
                        className="w-full mt-1 accent-red-500" />
                      <div className="flex justify-between text-[10px] text-gray-500"><span>1</span><span>Available: {Math.floor(gameState.troops)}</span></div>
                    </div>
                    <div>
                      <label className="text-xs text-gray-400">Tanks: <span className="text-white font-bold">{attackTanks}</span> <span className="text-yellow-400">(×10 power each)</span></label>
                      <input type="range" min={0} max={Math.floor(gameState.tanks)} value={attackTanks} onChange={e => setAttackTanks(+e.target.value)}
                        className="w-full mt-1 accent-yellow-500" />
                    </div>
                    <div>
                      <label className="text-xs text-gray-400">Planes: <span className="text-white font-bold">{attackPlanes}</span> <span className="text-cyan-400">(air superiority)</span></label>
                      <input type="range" min={0} max={Math.floor(gameState.planes)} value={attackPlanes} onChange={e => setAttackPlanes(+e.target.value)}
                        className="w-full mt-1 accent-cyan-500" />
                    </div>
                  </div>
                  <div className="flex gap-2 mt-4">
                    <button
                      onClick={() => {
                        if (!tc) return;
                        const frontProv = getFrontProvince(allProvinces[attackTarget] || []);
                        const isCapBattle = !(allProvinces[attackTarget] || []).some(p => !p.isFallen && !p.isCapital);
                        const frontTroops = frontProv
                          ? Math.floor((tc.troops) * frontProv.stationPercent / 100)
                          : Math.floor(tc.troops);
                        const fortCount   = tc.buildings.filter(b => b.type === "fort").length;
                        const defMult     = 1 + fortCount * 0.02;
                        const defenderPlanes = Math.floor(tc.planes);
                        setGameState(prev => prev ? { ...prev, troops: Math.max(0, prev.troops - attackTroops), tanks: Math.max(0, prev.tanks - attackTanks), planes: Math.max(0, prev.planes - attackPlanes) } : prev);
                        setBattle({
                          targetId: attackTarget, provinceId: frontProv?.id || "", isCapitalBattle: isCapBattle,
                          attacker: attackTroops, defender: frontTroops, attackerPlanes: attackPlanes,
                          defenderPlanes, attackerTanks: attackTanks, progress: 0,
                          defenseMult: defMult, initialDefender: frontTroops,
                        });
                        if (tc.owner?.startsWith("human-")) {
                          mpBroadcast({ type: "attack_started", from: myOwnerKeyRef.current, fromName: myNameRef.current, to: tc.owner, targetCountryId: attackTarget, troops: attackTroops });
                        }
                        showNotif(`⚔ Attacking ${tc.name} — ${frontProv?.name}!`);
                        setAttackTarget(null);
                      }}
                      className="flex-1 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white font-bold transition">
                      ⚔ Launch Attack!
                    </button>
                    <button onClick={() => setAttackTarget(null)} className="px-4 py-2 rounded-lg bg-[#2d3b2d] border border-[#4a5568] text-gray-300 hover:text-white transition">Cancel</button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* ── Battle modal ─────────────────────────────────────────────────── */}
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
              return (
                <>
                  <div className="text-white font-bold text-base mb-1">⚔ Battle for {tc?.name}</div>
                  {prov && (
                    <div className="text-[10px] text-orange-400 mb-2">
                      Province: {prov.name} ({prov.terrainLabel}) {battle.isCapitalBattle && "🏛 CAPITAL"}
                    </div>
                  )}
                  {/* Combatant bars */}
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-green-400">You: {Math.floor(battle.attacker).toLocaleString()} {battle.attackerTanks > 0 && `+🚜${Math.floor(battle.attackerTanks)}`} {battle.attackerPlanes > 0 && `+✈${Math.floor(battle.attackerPlanes)}`}</span>
                    <span className="text-red-400">{tc?.name}: {Math.floor(battle.defender).toLocaleString()} {battle.defenderPlanes > 0 && `+✈${Math.floor(battle.defenderPlanes)}`}</span>
                  </div>
                  <div className="flex gap-1 h-3 mb-3 rounded-full overflow-hidden">
                    <div className="bg-green-500 transition-all" style={{ width: `${(battle.attacker / (battle.attacker + battle.defender)) * 100}%` }} />
                    <div className="bg-red-500 transition-all" style={{ width: `${(battle.defender / (battle.attacker + battle.defender)) * 100}%` }} />
                  </div>
                  {/* Progress */}
                  <div className="mb-1 text-[10px] text-gray-400 flex justify-between">
                    <span>Assault progress</span>
                    <span>{Math.floor(battle.progress)}%</span>
                  </div>
                  <div className="w-full h-2 bg-[#2d3b2d] rounded-full mb-3">
                    <div className="h-full bg-[#f97316] rounded-full transition-all" style={{ width: `${battle.progress}%` }} />
                  </div>
                  {/* Status badges */}
                  <div className="flex flex-wrap gap-1 mb-3 text-[10px]">
                    {isForce  && <span className="px-2 py-0.5 rounded bg-orange-500/30 text-orange-300 border border-orange-400/50">⚡ Force Attack Active</span>}
                    {isLast   && <span className="px-2 py-0.5 rounded bg-purple-500/30 text-purple-300 border border-purple-400/50">🛡 Last Stand Active</span>}
                    {isAiLast && <span className="px-2 py-0.5 rounded bg-red-500/30 text-red-300 border border-red-400/50">🛡 Enemy Last Stand!</span>}
                  </div>
                  {/* BUG FIX #4: single wrapper div — was previously duplicated causing nested container layout break */}
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={() => setBattle(b => b ? { ...b, forceAttackUntil: Date.now() + 10000 } : b)}
                      disabled={isForce}
                      className="flex-1 py-1.5 rounded bg-orange-600 hover:bg-orange-500 text-white text-xs font-bold disabled:opacity-40 transition"
                      title="Force Attack: +50% damage dealt, +20% damage taken, 10s">
                      {isForce ? "⚡ Forcing…" : "⚡ Force Attack"}
                    </button>
                    <button
                      onClick={() => {
                        setBattle(b => b ? { ...b, lastStandUntil: Date.now() + 20000 } : b);
                        if (battle.targetId && gameState.countries[battle.targetId]?.owner?.startsWith("human-")) {
                          mpBroadcast({ type: "defender_last_stand", from: myOwnerKeyRef.current, targetCountryId: battle.targetId, until: Date.now() + 20000 });
                        }
                      }}
                      disabled={!canLast}
                      className="flex-1 py-1.5 rounded bg-purple-700 hover:bg-purple-600 text-white text-xs font-bold disabled:opacity-40 transition"
                      title="Last Stand: ×2 defense, +35% damage dealt, 20s, one-use">
                      {isLast ? "🛡 Defending…" : "🛡 Last Stand"}
                    </button>
                  </div>
                  <button
                    onClick={() => {
                      setGameState(prev => prev ? { ...prev, troops: prev.troops + battle.attacker, tanks: prev.tanks + battle.attackerTanks, planes: prev.planes + battle.attackerPlanes } : prev);
                      showNotif("🏃 Troops retreated.");
                      setBattle(null);
                    }}
                    className="w-full mt-2 py-1.5 rounded bg-[#2d3b2d] border border-[#4a5568] text-gray-300 hover:text-white text-xs transition">
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
          <div className="text-orange-400 font-bold text-sm mb-2">⚠ {defenderBattle.attackerName} is attacking {gameState.countries[defenderBattle.targetId]?.name}!</div>
          <div className="flex justify-between text-xs mb-1">
            <span className="text-red-400">Attacker: {Math.floor(defenderBattle.attacker).toLocaleString()}</span>
            <span className="text-green-400">Your troops: {Math.floor(defenderBattle.defender).toLocaleString()}</span>
          </div>
          <div className="flex gap-1 h-2 rounded-full overflow-hidden mb-2">
            <div className="bg-red-500" style={{ width: `${(defenderBattle.attacker / (defenderBattle.attacker + defenderBattle.defender)) * 100}%` }} />
            <div className="bg-green-500" style={{ width: `${(defenderBattle.defender / (defenderBattle.attacker + defenderBattle.defender)) * 100}%` }} />
          </div>
          <div className="w-full h-1.5 bg-[#2d3b2d] rounded-full">
            <div className="h-full bg-orange-400 rounded-full transition-all" style={{ width: `${defenderBattle.progress}%` }} />
          </div>
          <div className="text-[10px] text-gray-400 mt-1">Assault: {Math.floor(defenderBattle.progress)}%</div>
        </div>
      )}

      {/* ── Research panel ─────────────────────────────────────────────── */}
      {showResearch && (
        <div className="absolute top-1/2 right-20 -translate-y-1/2 z-30 w-80 bg-[#0f1420]/95 border border-[#4a5568] rounded-xl p-4 max-h-[70vh] overflow-y-auto">
          <div className="flex justify-between items-center mb-3">
            <h3 className="text-white font-bold">🔬 Research</h3>
            <button onClick={() => setShowResearch(false)} className="text-gray-400 hover:text-white">✕</button>
          </div>
          {gameState.activeResearch && (() => {
            const def = RESEARCH_DEFS.find(r => r.id === gameState.activeResearch!.id);
            if (!def) return null;
            const elapsed = Date.now() - gameState.activeResearch.startedAt;
            const pct = Math.min(100, (elapsed / def.durationMs) * 100);
            return (
              <div className="mb-3 p-2 rounded bg-[#1a2030]">
                <div className="text-xs text-cyan-400 font-bold">Researching: {def.label}</div>
                <div className="w-full h-2 bg-[#0f1420] rounded mt-1"><div className="h-full bg-cyan-500 rounded" style={{ width: `${pct}%` }} /></div>
                <div className="text-[10px] text-gray-400 text-right">{Math.ceil((def.durationMs - elapsed) / 1000)}s left</div>
              </div>
            );
          })()}
          <div className="text-[11px] text-gray-400 mb-2">Each branch up to 5 times (+10%/level).</div>
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
                      <div className="text-sm text-white font-bold">{r.label} <span className="text-cyan-400">Lv {lvl}/5</span> {maxed && "✅"}</div>
                      <div className="text-[10px] text-gray-400">{r.description} · +{lvl * 10}%</div>
                      <div className="text-[10px] text-yellow-400">{cost}g · {r.durationMs / 1000}s</div>
                    </div>
                    <button disabled={maxed || !!gameState.activeResearch || isActive || gameState.gold < cost}
                      onClick={() => { setGameState(prev => prev ? { ...prev, gold: prev.gold - cost, activeResearch: { id: r.id, startedAt: Date.now() } } : prev); showNotif(`🔬 Researching ${r.label} Lv ${lvl + 1}…`); }}
                      className="px-2 py-1 rounded bg-cyan-700 hover:bg-cyan-600 text-white text-xs disabled:opacity-30">
                      {maxed ? "Max" : isActive ? "Active" : `Lv ${lvl + 1}`}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Goals panel */}
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
                  <div className="text-[10px] text-cyan-400">{progress} · Reward: +{g.reward} PP</div>
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
            <h3 className="text-white font-bold">🔔 Notifications</h3>
            <button onClick={() => setShowNotifLog(false)} className="text-gray-400 hover:text-white">✕</button>
          </div>
          {gameState.notifications.length === 0
            ? <div className="text-xs text-gray-500 text-center py-4">No notifications yet.</div>
            : <div className="space-y-1">{gameState.notifications.map(n => (
                <div key={n.id} className="text-xs text-gray-300 p-2 bg-[#1a2030] rounded">
                  <div>{n.message}</div>
                  <div className="text-[9px] text-gray-500 mt-0.5">{new Date(n.timestamp).toLocaleTimeString()}</div>
                </div>
              ))}</div>
          }
        </div>
      )}

      {/* Formables panel */}
      {showFormables && (
        <div className="absolute top-1/2 right-20 -translate-y-1/2 z-30 w-80 bg-[#0f1420]/95 border border-[#4a5568] rounded-xl p-4 max-h-[70vh] overflow-y-auto">
          <div className="flex justify-between items-center mb-3">
            <h3 className="text-white font-bold">🏛 Formable Nations</h3>
            <button onClick={() => setShowFormables(false)} className="text-gray-400 hover:text-white">✕</button>
          </div>
          <div className="text-[11px] text-gray-400 mb-2">Own every required country then spend PP to form a unified nation.</div>
          <div className="space-y-2">
            {FORMABLES.map(f => {
              const formed   = (gameState.formedNations || []).includes(f.id);
              const owned    = f.requiredCountryIds.filter(id => gameState.countries[id]?.owner === "player").length;
              const total    = f.requiredCountryIds.length;
              const ready    = owned === total && !formed;
              const canAfford= gameState.politicalPower >= f.ppCost;
              return (
                <div key={f.id} className={`p-2 rounded border ${formed ? "border-green-500/50 bg-green-900/20" : ready ? "border-yellow-400/60 bg-yellow-900/10" : "border-[#4a5568] bg-[#1a2030]"}`}>
                  <div className="flex justify-between items-start gap-2">
                    <div className="flex-1">
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
                      className="px-2 py-1 rounded bg-yellow-600 hover:bg-yellow-500 text-white text-xs font-bold disabled:opacity-30 disabled:cursor-not-allowed">
                      {formed ? "Formed" : ready ? (canAfford ? "Form!" : "Need PP") : "Locked"}
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
          🧠 AI Advisor
        </button>
      </div>
      {showAdvisor && (
        <div className="absolute bottom-14 right-3 z-30 w-80 h-96 bg-[#0f1420]/95 backdrop-blur-md border border-[#4a5568] rounded-xl flex flex-col overflow-hidden">
          <div className="p-3 border-b border-[#4a5568] flex justify-between items-center">
            <span className="text-white font-bold text-sm">🧠 Strategy Advisor</span>
            <button onClick={() => setShowAdvisor(false)} className="text-gray-400 hover:text-white">✕</button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {advisorMessages.length === 0 && <div className="text-gray-500 text-xs text-center mt-8">Ask your advisor for strategic guidance…</div>}
            {advisorMessages.map((m, i) => (
              <div key={i} className={`text-xs p-2 rounded ${m.role === "user" ? "bg-[#7c3aed]/30 text-white ml-4" : "bg-[#2d3b2d]/50 text-gray-200 mr-4"}`}>{m.content}</div>
            ))}
          </div>
          <div className="p-2 border-t border-[#4a5568] flex gap-2">
            <input value={advisorInput} onChange={e => setAdvisorInput(e.target.value)} onKeyDown={e => e.key === "Enter" && sendAdvisorMsg()}
              placeholder="Ask for advice…" className="flex-1 px-2 py-1 rounded bg-[#1a2030] text-white text-xs border border-[#4a5568] focus:outline-none" />
            <button onClick={sendAdvisorMsg} disabled={advisorLoading} className="px-3 py-1 rounded bg-[#f97316] text-white text-xs font-bold disabled:opacity-50">{advisorLoading ? "…" : "Send"}</button>
          </div>
        </div>
      )}

      {/* Context menu */}
      {contextMenu && ctxCountry && (
        <div className="fixed z-40 bg-[#0f1420]/95 backdrop-blur-md border border-[#4a5568] rounded-xl py-2 min-w-[220px] shadow-2xl overflow-y-auto overscroll-contain"
          style={{ left: Math.min(contextMenu.x, window.innerWidth - 240), top: Math.min(contextMenu.y, Math.max(8, window.innerHeight - 380)), maxHeight: Math.min(window.innerHeight - 16, 480) }}
          onClick={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}>
          <div className="px-3 py-1 text-white font-bold text-sm border-b border-[#4a5568] mb-1">
            {getCountryFlag(contextMenu.countryId)} {ctxCountry.name}
          </div>
          {(() => {
            const isAlly  = !!(ctxCountry.owner && gameState.alliances.includes(ctxCountry.owner));
            const hasGoal = gameState.warGoals.includes(contextMenu.countryId);
            const atWar   = isAtWar(gameState.wars, contextMenu.countryId);
            const provs   = allProvinces[contextMenu.countryId] || [];
            const front   = getFrontProvince(provs);
            const fallen  = provs.filter(p => p.isFallen).length;
            return (
              <>
                <button onClick={() => handleDiplomacy("inspect")} className="w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-[#2d3b2d] flex items-center gap-2">👁 Inspect</button>
                <button onClick={() => handleDiplomacy("improve")} className="w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-[#2d3b2d] flex items-center gap-2">🤝 Improve Relations ({PP_COSTS.improve} PP)</button>
                <button onClick={() => handleDiplomacy("justify")} disabled={isAlly || hasGoal || atWar}
                  className="w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 disabled:text-gray-500 disabled:cursor-not-allowed text-gray-200 hover:bg-[#2d3b2d]">
                  📜 Justify War Goal {hasGoal ? "✅" : `(${PP_COSTS.justify} PP)`}
                </button>
                <button onClick={() => handleDiplomacy("guarantee")} className="w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-[#2d3b2d] flex items-center gap-2">🛡 Guarantee Independence ({PP_COSTS.guarantee} PP)</button>
                <button onClick={() => handleDiplomacy("trade")}    className="w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-[#2d3b2d] flex items-center gap-2">💰 Request Trade Deal</button>
                <button onClick={() => handleDiplomacy("diplomat")} className="w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-[#2d3b2d] flex items-center gap-2">📨 Send Diplomat ({PP_COSTS.diplomat} PP)</button>
                {isAlly ? (
                  <>
                    <button onClick={() => handleDiplomacy("breakAlliance")} className="w-full px-3 py-1.5 text-left text-sm text-orange-300 hover:bg-[#2d3b2d] flex items-center gap-2">💔 Break Alliance ({PP_COSTS.breakAlliance} PP)</button>
                    <button onClick={() => handleDiplomacy("requestTroops")} className="w-full px-3 py-1.5 text-left text-sm text-cyan-300 hover:bg-[#2d3b2d] flex items-center gap-2">🪖 Request Troops (yearly)</button>
                  </>
                ) : (
                  <button onClick={() => handleDiplomacy("ally")} className="w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-[#2d3b2d] flex items-center gap-2">🕊 Request Alliance (rel {ctxCountry.relations.player || 0}/70)</button>
                )}
                <div className="border-t border-[#4a5568] mt-1 pt-1">
                  {atWar ? (
                    <>
                      <button onClick={() => handleDiplomacy("attack")} className="w-full px-3 py-1.5 text-left text-sm font-bold flex items-center gap-2 hover:bg-[#2d3b2d]">
                        <span className="text-red-400">⚔ Attack</span>
                        {front && <span className="text-[10px] text-orange-300">→ {front.name}</span>}
                        {fallen > 0 && <span className="text-[10px] text-gray-400">({fallen} province{fallen > 1 ? "s" : ""} captured)</span>}
                      </button>
                      <button onClick={() => handleDiplomacy("makePeace")} className="w-full px-3 py-1.5 text-left text-sm text-green-400 hover:bg-[#2d3b2d] flex items-center gap-2">🕊 Make Peace (20 PP)</button>
                    </>
                  ) : (
                    <button onClick={() => handleDiplomacy("declareWar")} disabled={isAlly || !hasGoal}
                      className="w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 disabled:text-gray-500 disabled:cursor-not-allowed text-red-400 hover:bg-[#2d3b2d]">
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
            const goldPerSec= ((0.1 + cityCount * 0.05) * mult + inspectCountry.tradeDeals.length * 0.2) * 10;
            const troopsPerSec = 0.2 * mult * 10;
            const ownerId   = inspectCountry.owner;
            const lvls      = ownerId === "player" ? gameState.researchLevels : (ownerId ? gameState.botResearch?.[ownerId] : null);
            const provs     = allProvinces[inspecting!] || [];
            return (
              <div className="space-y-2 text-sm text-gray-300">
                <div>Owner: <span className="text-white">{inspectCountry.owner ? (inspectCountry.owner === "player" ? "You" : gameState.bots.find(b => b.id === inspectCountry.owner)?.name || "Unknown") : "Unowned"}</span></div>
                {ownerId && gameState.alliances.includes(ownerId) && <div className="text-cyan-400 font-bold">🕊 Allied with you</div>}
                <div>Troops: <span className="text-white">{Math.floor(inspectCountry.troops)}</span> <span className="text-green-400">(+{troopsPerSec.toFixed(1)}/s)</span></div>
                <div>Tanks: <span className="text-white">{Math.floor(inspectCountry.tanks)}</span></div>
                <div>Planes: <span className="text-white">{Math.floor(inspectCountry.planes)}</span></div>
                <div>Gold: <span className="text-white">{Math.floor(inspectCountry.gold)}</span> <span className="text-yellow-400">(+{goldPerSec.toFixed(1)}/s)</span></div>
                <div>Buildings: <span className="text-white">{inspectCountry.buildings.length > 0 ? inspectCountry.buildings.map(b => b.icon).join(" ") : "None"}</span></div>
                <div>Relations with you: <span className="text-white">{inspectCountry.relations.player || 0}</span></div>
                <div>Trade Deals: <span className="text-white">{inspectCountry.tradeDeals.length}</span></div>
                {provs.length > 0 && (
                  <div className="pt-1 border-t border-[#4a5568]">
                    <div className="text-[11px] text-[#a78bfa] font-bold mb-1">🗺 Provinces ({provs.length})</div>
                    {provs.map(p => (
                      <div key={p.id} className={`text-[11px] mb-0.5 ${p.isFallen ? "text-red-400 line-through" : "text-gray-300"}`}>
                        {p.isCapital ? "🏛" : "🗺"} {p.name} — {p.stationPercent}% troops · {p.terrainLabel} {p.isFallen ? "(FALLEN)" : ""}
                      </div>
                    ))}
                  </div>
                )}
                {lvls && (
                  <div className="pt-1 border-t border-[#4a5568]">
                    <div className="text-[11px] text-cyan-400 font-bold mb-1">🔬 Research Levels</div>
                    <div className="grid grid-cols-2 gap-1 text-[10px]">
                      {Object.entries(lvls).map(([k, v]) => (
                        <div key={k} className="text-gray-300">{k.toUpperCase()}: <span className="text-white">Lv {v as number}</span></div>
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
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 bg-[#0f1420]/95 border border-[#f97316]/60 rounded-lg px-4 py-2 text-white text-sm font-medium shadow-xl pointer-events-none">
          {notification}
        </div>
      )}

      {/* Building mode hint */}
      {selectedBuilding && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-20 bg-[#7c3aed]/90 border border-[#a78bfa] rounded-lg px-4 py-1.5 text-white text-xs font-bold pointer-events-none">
          🏗 Click your territory to place {BUILDING_DEFS[selectedBuilding].icon} {BUILDING_DEFS[selectedBuilding].label} (×{buildMultiplier}) — ESC to cancel
        </div>
      )}
    </div>
  );
}
