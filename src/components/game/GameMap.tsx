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

// Helper to check if at war with a country
function isAtWar(wars: War[], countryId: string): boolean {
  return wars.some(w => w.countryId === countryId);
}
function getWar(wars: War[], countryId: string): War | undefined {
  return wars.find(w => w.countryId === countryId);
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

// Per-country economy multipliers. ISO numeric codes.
// Multipliers apply to BOTH gold and troop generation per country, every tick.
const COUNTRY_ECON_MULT: Record<string, number> = {
  // Major powers — gain dramatically more
  "840": 9.5, // USA
  "156": 9.5, // China
  "356": 8.0, // India
  "076": 6.5, // Brazil
  "643": 8.0, // Russia
  // Secondary powers — clearly above average but well below majors
  "250": 4.0, // France
  "826": 4.0, // United Kingdom
  "586": 3.5, // Pakistan
  "682": 4.0, // Saudi Arabia
  "124": 4.0, // Canada
  "276": 4.2, // Germany
};

// Small deterministic variance so every "normal" country earns at a slightly
// different rate (range ~0.7x – 1.25x of base). Major/secondary powers keep
// their explicit multipliers above and are NOT touched by this.
function variance(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  // Map hash to 0.7 .. 1.25
  return 0.7 + ((h % 1000) / 1000) * 0.55;
}
function effectiveMult(id: string): number {
  if (COUNTRY_ECON_MULT[id] != null) {
    // Tiny ±5% jitter so even majors differ slightly from each other
    const j = 0.95 + ((Array.from(id).reduce((a, c) => a + c.charCodeAt(0), 0) % 100) / 1000);
    return COUNTRY_ECON_MULT[id] * j;
  }
  return variance(id);
}

export default function GameMap({ playerCountryId, difficulty = "easy", lobbyId, onExit }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [features, setFeatures] = useState<Feature<Geometry>[]>([]);
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [selectedBuilding, setSelectedBuilding] = useState<BuildingType | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; countryId: string } | null>(null);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [notification, setNotification] = useState<string | null>(null);
  const [showAdvisor, setShowAdvisor] = useState(false);
  const [advisorMessages, setAdvisorMessages] = useState<{ role: string; content: string }[]>([]);
  const [advisorInput, setAdvisorInput] = useState("");
  const [advisorLoading, setAdvisorLoading] = useState(false);
  const [showFullLeaderboard, setShowFullLeaderboard] = useState(false);
  // Battle UI state
  const [attackTarget, setAttackTarget] = useState<string | null>(null);
  const [attackTroops, setAttackTroops] = useState<number>(0);
  const [battle, setBattle] = useState<{
    targetId: string;
    attacker: number;
    defender: number;
    attackerPlanes: number;
    defenderPlanes: number;
    attackerTanks: number;
    progress: number; // 0..100
    defenseMult: number;
    forceAttackUntil?: number;
    lastStandUntil?: number;
    aiLastStandUntil?: number;
    aiLastStandUsed?: boolean;
    initialDefender?: number;
  } | null>(null);
  // Live read-only battle view shown to the DEFENDER when another human attacks one of our countries.
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
  const [lastTroopRequestYear, setLastTroopRequestYear] = useState<number>(0);
  const [showResearch, setShowResearch] = useState(false);
  const [showGoals, setShowGoals] = useState(false);
  const [showNotifLog, setShowNotifLog] = useState(false);
  const [showFormables, setShowFormables] = useState(false);
  const [buildMultiplier, setBuildMultiplier] = useState<1 | 5 | 10>(1);
  const [attackTanks, setAttackTanks] = useState<number>(0);
  const [attackPlanes, setAttackPlanes] = useState<number>(0);
  const gameStateRef = useRef<GameState | null>(null);
  const featuresRef = useRef<Feature<Geometry>[]>([]);
  // Neighbor map: countryId -> Set of bordering countryIds
  const neighborsRef = useRef<Record<string, Set<string>>>({});
  // Multiplayer sync refs
  const myUserIdRef = useRef<string | null>(null);
  const myOwnerKeyRef = useRef<string>("player");
  const myNameRef = useRef<string>("Player");
  const myColorRef = useRef<string>(PLAYER_COLOR);
  const mpChannelRef = useRef<{ broadcast: (e: any) => void; leave: () => void } | null>(null);
  const humanByOwnerKeyRef = useRef<Record<string, { name: string; color: string }>>({});

  const mpBroadcast = useCallback((event: any) => {
    mpChannelRef.current?.broadcast(event);
  }, []);
  // Convert local owner id ("player" → my human key) for outgoing wire events
  const ownerOut = useCallback((owner: string | null) => {
    if (!owner) return null;
    if (owner === "player") return myOwnerKeyRef.current;
    return owner;
  }, []);
  // Convert wire owner id (my human key → "player") for incoming events
  const ownerIn = useCallback((owner: string | null) => {
    if (!owner) return null;
    if (owner === myOwnerKeyRef.current) return "player";
    return owner;
  }, []);

  // Load map data
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // If part of a multiplayer lobby, fetch other players' country picks first.
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
            myNameRef.current = p.display_name;
            myColorRef.current = p.color;
          } else if (p.country_id && p.country_id !== playerCountryId) {
            reservedOwners![p.country_id] = { id: key, name: p.display_name, color: p.color };
          }
        });
        humanByOwnerKeyRef.current = humanMap;
      }
     const topo: Topology = await fetch("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json").then(r => r.json());
      if (cancelled) return;

      const geo = feature(topo, topo.objects.countries as GeometryCollection) as unknown as FeatureCollection;
      const feats = geo.features.filter((f) => !EXCLUDED.includes(f.id as string));
      setFeatures(feats);
      featuresRef.current = feats;
      const allIds = feats.map((f) => f.id as string);

      const allObjects = (topo.objects.countries as any).geometries;
      const nbArrays = topoNeighbors(allObjects);
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
        "688","705","703","728","748","762","795","800","860","807","716","894","499","268",
      ]);

      for (const id of allIds) {
        if (gs.countries[id]) {
          gs.countries[id].isCoastal = !LANDLOCKED.has(id);
        }
      }
      setGameState(gs);
    }
    init();
    return () => { cancelled = true; };
  }, [playerCountryId, difficulty, lobbyId, seed]);

  // Multiplayer realtime sync: join channel + apply incoming events
  useEffect(() => {
    if (!lobbyId) return;
    let cancelled = false;
    (async () => {
      const { joinLobbyChannel } = await import("@/game/multiplayerSync");
      if (cancelled) return;
      const ch = joinLobbyChannel(lobbyId, (event) => {
        const ev = event as any;
        // Map wire owner ids back to local frame ("player" if it's me)
        const fromLocal = ownerIn(ev.from);
        const toLocal = ev.to ? ownerIn(ev.to) : null;
        const newOwnerLocal = ev.newOwner ? ownerIn(ev.newOwner) : null;
        const previousOwnerLocal = ev.previousOwner ? ownerIn(ev.previousOwner) : null;
        const fromInfo = humanByOwnerKeyRef.current[ev.from];
        const fromName = ev.fromName || fromInfo?.name || "Another player";

        if (ev.type === "build") {
          setGameState((prev) => {
            if (!prev) return prev;
            const c = prev.countries[ev.countryId];
            if (!c) return prev;
            const next = { ...c, buildings: [...c.buildings, ev.building] };
            return { ...prev, countries: { ...prev.countries, [ev.countryId]: next } };
          });
        } else if (ev.type === "war_declared") {
          // Are we the target?
          if (toLocal === "player") {
            setGameState((prev) => {
              if (!prev) return prev;
              // Add wars vs every country owned by attacker
              const attackerCountries = Object.values(prev.countries).filter(c => c.owner === ev.from);
              const existing = new Set(prev.wars.map(w => w.countryId));
              const newWars = [...prev.wars];
              for (const c of attackerCountries) {
                if (!existing.has(c.id)) newWars.push({ countryId: c.id, startedAt: Date.now() });
              }
              return { ...prev, wars: newWars };
            });
            setNotification(`⚔ ${fromName} DECLARED WAR on you!`);
            setTimeout(() => setNotification(null), 4000);
          }
        } else if (ev.type === "war_ended") {
          if (toLocal === "player") {
            setGameState((prev) => {
              if (!prev) return prev;
              const attackerCountries = new Set(
                Object.values(prev.countries).filter(c => c.owner === ev.from).map(c => c.id)
              );
              return { ...prev, wars: prev.wars.filter(w => !attackerCountries.has(w.countryId)) };
            });
            setNotification(`🕊 ${fromName} made peace with you.`);
            setTimeout(() => setNotification(null), 3500);
          }
        } else if (ev.type === "attack_started") {
          // Show defender notification only if target is locally ours
          setGameState((prev) => {
            if (prev && prev.countries[ev.targetCountryId]?.owner === "player") {
              const cName = prev.countries[ev.targetCountryId].name;
              setNotification(`⚠ ${fromName} is ATTACKING ${cName} with ${ev.troops} troops!`);
              setTimeout(() => setNotification(null), 4500);
            }
            return prev;
          });
        } else if (ev.type === "country_captured") {
          setGameState((prev) => {
            if (!prev) return prev;
            const c = prev.countries[ev.countryId];
            if (!c) return prev;
            const wasMine = c.owner === "player";
            const newOwner = newOwnerLocal!;
            const next = {
              ...c,
              owner: newOwner,
              color: newOwner === "player" ? PLAYER_COLOR : ev.newOwnerColor,
              troops: ev.troopsLeft,
            };
            const cleanedWars = prev.wars.filter(w => w.countryId !== ev.countryId);
            if (wasMine) {
              setNotification(`💀 You LOST ${c.name} to ${fromName}!`);
              setTimeout(() => setNotification(null), 4500);
            }
            return { ...prev, countries: { ...prev.countries, [ev.countryId]: next }, wars: cleanedWars };
          });
          // Battle ends if we were viewing it as defender
          setDefenderBattle((db) => (db && db.targetId === ev.countryId ? null : db));
        } else if (ev.type === "battle_state") {
          // Only react if this battle targets one of OUR countries
          const cs = gameStateRef.current;
          if (!cs) return;
          const c = cs.countries[ev.targetCountryId];
          if (!c || c.owner !== "player") return;
          setDefenderBattle({
            targetId: ev.targetCountryId,
            attackerKey: ev.from,
            attackerName: ev.fromName,
            attacker: ev.attacker,
            defender: ev.defender,
            attackerTanks: ev.attackerTanks,
            attackerPlanes: ev.attackerPlanes,
            defenderPlanes: ev.defenderPlanes,
            progress: ev.progress,
            defenseMult: ev.defenseMult,
            forceAttackUntil: ev.forceAttackUntil,
            lastStandUntil: ev.defenderLastStandUntil,
            updatedAt: Date.now(),
          });
        } else if (ev.type === "battle_ended") {
          setDefenderBattle((db) => (db && db.targetId === ev.targetCountryId ? null : db));
        } else if (ev.type === "defender_last_stand") {
          // Defender (other human) activated last stand against us — apply to our local battle
          setBattle((b) => {
            if (!b || b.targetId !== ev.targetCountryId) return b;
            return { ...b, aiLastStandUntil: ev.until, aiLastStandUsed: true };
          });
        }
      });
      mpChannelRef.current = ch;
    })();
    return () => {
      cancelled = true;
      mpChannelRef.current?.leave();
      mpChannelRef.current = null;
    };
  }, [lobbyId, ownerIn]);

  // Draw map
  useEffect(() => {
    if (!svgRef.current || features.length === 0 || !gameState) return;
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
    svg.call(zoom);

    // Store zoom and projection for keyboard pan (use custom keys, NOT __zoom which d3 owns)
    (svgRef.current as any).__zoomBehavior = zoom;
    (svgRef.current as any).__projection = projection;

    const g = svg.select<SVGGElement>("g.map-group");

    g.selectAll("path.country")
      .data(features, (d: any) => d.id)
      .join("path")
      .attr("class", "country")
      .attr("d", (d) => path(d) || "")
      .attr("data-id", (d) => d.id as string);

    // Building labels — one per building, positioned at click point
    const allBuildings: Array<{ key: string; x: number; y: number; icon: string }> = [];
    for (const f of features) {
      const c = gameState.countries[f.id as string];
      if (!c || c.buildings.length === 0) continue;
      const centroid = path.centroid(f);
      c.buildings.forEach((b, i) => {
        let xOffset = 0;
        let yOffset = 0;
        if (b.x === undefined || b.y === undefined) {
          const angle = i * 2.39996;
          const radius = 6 * Math.sqrt(i);
          xOffset = Math.cos(angle) * radius;
          yOffset = Math.sin(angle) * radius;
        }
        const x = (b.x ?? centroid[0]) + xOffset;
        const y = (b.y ?? centroid[1]) + yOffset;
        allBuildings.push({ key: `${f.id}-${i}`, x, y, icon: b.icon });
      });
    }
    g.selectAll("text.building-label")
      .data(allBuildings, (d: any) => d.key)
      .join("text")
      .attr("class", "building-label")
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "central")
      .attr("font-size", "10px")
      .attr("pointer-events", "none")
      .attr("x", (d) => d.x)
      .attr("y", (d) => d.y)
      .text((d) => d.icon);

    updateFills(gameState);
  }, [features, gameState]);

  const updateFills = useCallback((gs: GameState) => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll<SVGPathElement, Feature>("path.country")
      .attr("fill", (d) => {
        const id = d.id as string;
        const c = gs.countries[id];
        if (!c) return "#2d3b2d";
        if (c.owner) return c.color + "cc"; // owned: 80% opacity
        return c.color || "#5a6b5a"; // unowned: muted color, full opacity
      })
      .attr("stroke", (d) => {
        const id = d.id as string;
        if (id === gs.playerCountryId) return "#a78bfa";
        const c = gs.countries[id];
        if (c?.owner && gs.alliances.includes(c.owner)) return "#22d3ee"; // cyan border for allies
        return "#4a5568";
      })
      .attr("stroke-width", (d) => {
        const id = d.id as string;
        if (id === gs.playerCountryId) return 1.5;
        const c = gs.countries[id];
        if (c?.owner && gs.alliances.includes(c.owner)) return 1.5;
        return 0.5;
      });
  }, []);

  // Game loop - economy tick (100ms)
  useEffect(() => {
    if (!gameState) return;
    const interval = setInterval(() => {
      setGameState((prev) => {
        if (!prev || prev.paused) return prev;
        const ticksPerSec = prev.speed;
        const newDate = advanceDate(prev.date, ticksPerSec);
        const now = Date.now();

        const newCountries = { ...prev.countries };
        let playerGoldBonusFromTrade = 0;
        let playerTanksGain = 0;
        let playerPlanesGain = 0;
        let playerGoldUpkeep = 0;
        let playerCourthousePP = 0;

        const playerAtWar = prev.wars.length > 0;

        // Difficulty: easy = no change. Normal: player -25% gold/troops/PP, AI +25%. Hard: player -50%, AI +50%.
        const aiBuff = difficulty === "hard" ? 1.5 : difficulty === "normal" ? 1.25 : 1.0;
        const playerNerf = difficulty === "hard" ? 0.5 : difficulty === "normal" ? 0.75 : 1.0;
        for (const cid in newCountries) {
          const c = newCountries[cid];
          const isBot = c.owner && c.owner !== "player";
          const econMult = isBot ? aiBuff : playerNerf;
          const mult = effectiveMult(cid) * econMult;
          const cityCount = c.buildings.filter(b => b.type === "city").length;
          const factoryCount = c.buildings.filter(b => b.type === "factory").length;
          const barracksCount = c.buildings.filter(b => b.type === "barracks").length;
          const courthouseCount = c.buildings.filter(b => b.type === "courthouse").length;
          const airbaseCount = c.buildings.filter(b => b.type === "airbase").length;
          const portCount = c.buildings.filter(b => b.type === "port").length;

          const goldGain = (0.1 + cityCount * 0.05) * mult;
          // Factories no longer produce troops — they only produce tanks (1 tank = 10 troop strength in combat).
          const troopGain = (0.2 + barracksCount * 0.02) * mult;
          // Tanks: 1 tank per second per factory => 0.1/tick (also gets AI buff)
          const tankGain = factoryCount * 0.1 * econMult;
          // Planes: 1 plane per second per airbase => 0.1/tick, costs 0.2 gold/tick (2/sec)
          const planeGain = airbaseCount * 0.1 * econMult;
          const airUpkeep = airbaseCount * 0.2;

          const tradeBonus = c.tradeDeals.length * 0.2;
          if (c.tradeDeals.includes("player") && c.owner !== "player") {
            playerGoldBonusFromTrade += 0.2;
          }

          let newGold = c.gold + goldGain + tradeBonus - airUpkeep;
          if (newGold < 0) newGold = 0;
          let newBuildings = c.buildings;

          // Diplomat mission: +0.1 relation per tick (1/sec) toward player
          let newRelations = c.relations;
          if (c.diplomatUntil && now < c.diplomatUntil) {
            newRelations = { ...c.relations, player: (c.relations.player || 0) + 0.1 };
          }
          let newDiplomatUntil = c.diplomatUntil;
          if (c.diplomatUntil && now >= c.diplomatUntil) {
            newDiplomatUntil = undefined;
          }

          // ---- AI building logic ----
          // Bots only act on bot-owned countries; never on the local player or
          // any other human player ("human-*" owners are remote humans).
          if (c.owner && c.owner !== "player" && !c.owner.startsWith("human-")) {
            const totalBuilt = c.buildings.length;
            // Pick what to build — priority order:
            // 1. Cities (primary income engine) — always want more
            // 2. Barracks (military readiness) — up to 3
            // 3. Factories (tanks) — up to 2
            // 4. Courthouse (PP) — 1 per country
            // 5. Airbase (planes, expensive upkeep) — only rich majors or late game
            // 6. Port — ONLY if country is a true island (no land neighbors at all)
            // 7. Fort — if being attacked by player
            let nextType: BuildingType = "city";
            const isTargetOfPlayer = prev.wars.some(w => w.countryId === cid);
            const fortCount = c.buildings.filter(b => b.type === "fort").length;
            const isRichMajor = !!(COUNTRY_ECON_MULT[cid] && COUNTRY_ECON_MULT[cid] >= 3.0);
            const desiredAirbases = isRichMajor ? 4 : 1;
            const airbaseThreshold = isRichMajor ? 5 : 10; // more buildings before airbase
            const desiredCities = isRichMajor ? 8 : 5;
            const desiredBarracks = isRichMajor ? 4 : 3;
            const desiredFactories = isRichMajor ? 3 : 2;

            // Port only for true islands: coastal AND no land neighbors
            // neighborsRef stores Set<string>, so use .size not .length
            const nbsSet = neighborsRef.current[cid];
            const hasNoLandNeighbors = !nbsSet || nbsSet.size === 0;
            const isIsland = c.isCoastal !== false && hasNoLandNeighbors;
            const desiredPorts = isIsland ? 1 : 0;

            if (isTargetOfPlayer && fortCount < 5) {
              nextType = "fort";
            } else if (cityCount < desiredCities) {
              nextType = "city";
            } else if (barracksCount < desiredBarracks) {
              nextType = "barracks";
            } else if (factoryCount < desiredFactories) {
              nextType = "factory";
            } else if (courthouseCount < 1) {
              nextType = "courthouse";
            } else if (totalBuilt >= airbaseThreshold && airbaseCount < desiredAirbases) {
              nextType = "airbase";
            } else if (isIsland && portCount < desiredPorts) {
              nextType = "port";
            } else {
              nextType = "city"; // keep building cities
            }
            const def = BUILDING_DEFS[nextType];
            if (newGold >= def.cost && totalBuilt < 25) {
              newGold -= def.cost;
              newBuildings = [...newBuildings, { type: nextType, icon: def.icon }];
            }
          }

          // Player country aggregations
          if (c.owner === "player") {
            playerTanksGain += tankGain;
            playerPlanesGain += planeGain;
            playerCourthousePP += courthouseCount * 0.05;
          }

          newCountries[cid] = {
            ...c,
            gold: newGold,
            troops: c.troops + troopGain,
            tanks: c.tanks + tankGain,
            planes: c.planes + planeGain,
            buildings: newBuildings,
            relations: newRelations,
            diplomatUntil: newDiplomatUntil,
          };
        }

        // Player aggregate resources (difficulty nerfs player gold/troops/PP and buffs AI)
        const goldRate = getGoldRate(prev);
        const troopRate = getTroopRate(prev);
        const ppRate = getPoliticalPowerRate(prev);

        // Research bonuses: +10% per level (max 5 levels = +50%)
        const goldLvl = prev.researchLevels?.gold || 0;
        const troopLvl = prev.researchLevels?.troop || 0;
        const goldMult = 1 + goldLvl * 0.1;
        const troopMult = 1 + troopLvl * 0.1;

        // Active research progress check
        let researchLevels = { ...(prev.researchLevels || {}) };
        let activeResearch = prev.activeResearch;
        if (activeResearch) {
          const def = RESEARCH_DEFS.find(r => r.id === activeResearch!.id);
          if (def && now - activeResearch.startedAt >= def.durationMs) {
            researchLevels[activeResearch.id] = (researchLevels[activeResearch.id] || 0) + 1;
            setTimeout(() => showNotif(`✅ ${def.label} Lv${researchLevels[def.id]} complete!`), 0);
            activeResearch = null;
          }
        }

        // Goal check
        let completedGoals = prev.completedGoals;
        let goalReward = 0;
        const ownedCountryIds = Object.values(prev.countries).filter(c => c.owner === "player").map(c => c.id);
        const ownedCount = ownedCountryIds.length;
        const startContinent = CONTINENTS[prev.playerCountryId];
        for (const goal of GOALS) {
          if (completedGoals.includes(goal.id)) continue;
          let achieved = false;
          if (goal.id === "continent" && startContinent) {
            const inContinent = Object.keys(CONTINENTS).filter(id => CONTINENTS[id] === startContinent && prev.countries[id]);
            achieved = inContinent.length > 0 && inContinent.every(id => prev.countries[id]?.owner === "player");
          } else if (goal.id === "ten") {
            achieved = ownedCount >= 10;
          } else if (goal.id === "twentyfive") {
            achieved = ownedCount >= 25;
          }
          if (achieved) {
            completedGoals = [...completedGoals, goal.id];
            goalReward += goal.reward;
            // Notification scheduled outside (can't call setState here cleanly)
            setTimeout(() => showNotif(`🏆 Goal completed: ${goal.label}! +${goal.reward} PP`), 0);
          }
        }

        const next = {
          ...prev,
          gold: prev.gold + ((goldRate / 10) * goldMult + playerGoldBonusFromTrade) * playerNerf,
          troops: prev.troops + (troopRate / 10) * troopMult * playerNerf,
          tanks: prev.tanks + playerTanksGain,
          planes: prev.planes + playerPlanesGain,
          politicalPower: prev.politicalPower + (ppRate / 10 + playerCourthousePP) * playerNerf + goalReward,
          date: newDate,
          countries: newCountries,
          researchLevels,
          activeResearch,
          completedGoals,
        };
        gameStateRef.current = next;
        return next;
      });
    }, 100);
    return () => clearInterval(interval);
  }, [gameState?.paused, gameState?.speed, difficulty]);

  // Battle tick — runs every 250ms when a battle is active.
  useEffect(() => {
    if (!battle) return;
    const iv = setInterval(() => {
      setBattle((b) => {
        if (!b) return b;
        const now = Date.now();
        const isForceAttack = !!(b.forceAttackUntil && now < b.forceAttackUntil);
        const isLastStand = !!(b.lastStandUntil && now < b.lastStandUntil);
        // AI auto Last Stand: when defender drops below 30% of initial, trigger once for 20s
        let aiLastStandUntil = b.aiLastStandUntil;
        let aiLastStandUsed = b.aiLastStandUsed;
        const initDef = b.initialDefender || b.defender;
        if (!aiLastStandUsed && b.defender > 0 && b.defender < initDef * 0.3) {
          aiLastStandUntil = now + 20000;
          aiLastStandUsed = true;
          setTimeout(() => showNotif(`🛡 ${gameStateRef.current?.countries[b.targetId]?.name || "Enemy"} initiated Last Stand!`), 0);
        }
        const isAiLastStand = !!(aiLastStandUntil && now < aiLastStandUntil);

        // Air superiority: whoever has more planes gets a +50% bonus.
        // We arbitrate to attacker by default for tie.
        let airBonusAtk = 1;
        let airBonusDef = 1;
        if (b.attackerPlanes > b.defenderPlanes) airBonusAtk = 1.5;
        else if (b.defenderPlanes > b.attackerPlanes) airBonusDef = 1.5;

        // Tanks count as 10 effective troops in combat math
        const atkEff = b.attacker + b.attackerTanks * 10;
        const defEff = b.defender;

        // Research bonuses (read from gameStateRef): +10% per level
        const rl = gameStateRef.current?.researchLevels || {};
        const atkResearch = 1 + ((rl.atk || 0) * 0.1);
        const defResearch = 1 + ((rl.def || 0) * 0.1);

        let defMult = b.defenseMult * defResearch * airBonusDef;
        const defCountry = gameStateRef.current?.countries[b.targetId];
        const courthouseDefBonus = defCountry ? 1 + defCountry.buildings.filter(b2 => b2.type === "courthouse").length * 0.20 : 1;
        defMult *= courthouseDefBonus;
        if (isLastStand) defMult *= 2;
        if (isAiLastStand) defMult *= 2;

        const atkPower = (isForceAttack ? 1.5 : 1) * atkResearch * airBonusAtk;
        const ratio = atkEff / Math.max(1, defEff);

        let atkLossMult = 1;
        if (isForceAttack) atkLossMult *= 1.2;
        const atkLoss = Math.ceil(b.attacker * 0.010 * defMult / Math.max(0.5, Math.sqrt(ratio)) * (0.8 + Math.random() * 0.4) * atkLossMult);

        let defLossMult = atkPower;
        if (isLastStand) defLossMult *= 1.35;
        const defLoss = Math.ceil(b.defender * 0.010 * Math.sqrt(ratio) / defMult * (0.8 + Math.random() * 0.4) * defLossMult);

        // Tank attrition: lose ~1% of tanks per tick during combat
        const tankLoss = Math.ceil(b.attackerTanks * 0.008 * (isForceAttack ? 1.2 : 1));
        // Plane attrition: small losses per tick on both sides
        const atkPlaneLoss = Math.ceil(b.attackerPlanes * 0.005);
        const defPlaneLoss = Math.ceil(b.defenderPlanes * 0.005);

        const newAtk = Math.max(0, b.attacker - atkLoss);
        const newDef = Math.max(0, b.defender - defLoss);
        const newAtkTanks = Math.max(0, b.attackerTanks - tankLoss);
        const newAtkPlanes = Math.max(0, b.attackerPlanes - atkPlaneLoss);
        const newDefPlanes = Math.max(0, b.defenderPlanes - defPlaneLoss);
        const progressSpeed = isForceAttack ? 1.5 : 1;
        const progressGain = Math.max(0.2, Math.min(3, ratio * 0.8)) * progressSpeed;
        const progress = Math.min(100, b.progress + progressGain);

        // Tighter stalemate: only if very close ratio AND both sides healthy
        const stalemate = progress >= 100 && newAtk > 100 && newDef > 100 && Math.abs(ratio - 1) < 0.15;
        if (newAtk <= 0 || newDef <= 0 || stalemate) {
          setGameState((prev) => {
            if (!prev) return prev;
            const target = { ...prev.countries[b.targetId] };
            target.troops = newDef;
            target.planes = Math.max(0, target.planes - (b.defenderPlanes - newDefPlanes));
            const newCountries = { ...prev.countries, [b.targetId]: target };
            let newTroops = prev.troops + newAtk;
            let newTanks = prev.tanks + newAtkTanks;
            let newPlanes = prev.planes + newAtkPlanes;
            let newGoldTotal = prev.gold;
            let newWars = prev.wars;
            if (newDef <= 0 && newAtk > 0) {
              const previousOwner = target.owner;
              // War spoils: capture the conquered country's treasury
              const looted = Math.floor(target.gold);
              newGoldTotal += looted;
              target.gold = 0;
              target.owner = "player";
              target.color = PLAYER_COLOR;
              target.troops = Math.max(50, Math.floor(newAtk * 0.5));
              newTroops -= target.troops;
              newCountries[b.targetId] = target;
              newWars = removeWar(prev.wars, b.targetId);
              setTimeout(() => showNotif(`🏆 Conquered ${target.name}! Looted ${looted} gold.`), 0);
              // Broadcast capture so other players' maps update
              mpBroadcast({
                type: "country_captured",
                from: myOwnerKeyRef.current,
                fromName: myNameRef.current,
                previousOwner: previousOwner === "player" ? myOwnerKeyRef.current : previousOwner,
                countryId: b.targetId,
                newOwner: myOwnerKeyRef.current,
                newOwnerColor: myColorRef.current,
                troopsLeft: target.troops,
              });
            } else if (newAtk <= 0) {
              setTimeout(() => showNotif(`💀 Attack on ${target.name} failed — your forces were destroyed.`), 0);
            } else {
              setTimeout(() => showNotif(`🛑 Battle for ${target.name} ended in stalemate.`), 0);
            }
            return {
              ...prev,
              gold: newGoldTotal,
              troops: Math.max(0, newTroops),
              tanks: Math.max(0, newTanks),
              planes: Math.max(0, newPlanes),
              countries: newCountries,
              wars: newWars,
            };
          });
          // Tell other clients the battle is over (clears defender's modal)
          const targetCountry = gameStateRef.current?.countries[b.targetId];
          if (targetCountry?.owner && targetCountry.owner.startsWith("human-")) {
            mpBroadcast({ type: "battle_ended", from: myOwnerKeyRef.current, targetCountryId: b.targetId });
          }
          return null;
        }
        const next = {
          ...b,
          attacker: newAtk,
          defender: newDef,
          attackerTanks: newAtkTanks,
          attackerPlanes: newAtkPlanes,
          defenderPlanes: newDefPlanes,
          progress,
          aiLastStandUntil,
          aiLastStandUsed,
        };
        // Live-broadcast battle state to defender if they're another human
        const tgt = gameStateRef.current?.countries[b.targetId];
        if (tgt?.owner && tgt.owner.startsWith("human-")) {
          mpBroadcast({
            type: "battle_state",
            from: myOwnerKeyRef.current,
            fromName: myNameRef.current,
            targetCountryId: b.targetId,
            attacker: next.attacker,
            defender: next.defender,
            attackerTanks: next.attackerTanks,
            attackerPlanes: next.attackerPlanes,
            defenderPlanes: next.defenderPlanes,
            progress: next.progress,
            defenseMult: b.defenseMult,
            forceAttackUntil: next.forceAttackUntil,
            defenderLastStandUntil: next.aiLastStandUntil,
          });
        }
        return next;
      });
    }, 250);
    return () => clearInterval(iv);
  }, [battle?.targetId, mpBroadcast]);

  // Bot counter-attack: after 60 seconds of war, bots attack every 20 seconds.
  // Runs every 2s for snappier checks.
  useEffect(() => {
    if (!gameState) return;
    const iv = setInterval(() => {
      const prev = gameStateRef.current;
      if (!prev || prev.paused) return;
      const now = Date.now();
      const wars = prev.wars;
      if (wars.length === 0) return;
      const updates: { war: War; damage: number; enemyName: string }[] = [];
      for (const w of wars) {
        if (now - w.startedAt < 60000) continue; // 60s grace
        if (w.lastBotAttack && now - w.lastBotAttack < 20000) continue; // 20s cooldown
        const enemy = prev.countries[w.countryId];
        if (!enemy || !enemy.owner || enemy.owner === "player") continue;
        // Skip auto counter-attack on human-owned countries — real humans
        // attack you via multiplayer events, not bot AI.
        if (enemy.owner.startsWith("human-")) continue;
        const botForce = Math.floor(enemy.troops * 0.25);
        const damage = Math.max(20, Math.floor(botForce * 0.25));
        updates.push({ war: w, damage, enemyName: enemy.name });
      }
      if (updates.length === 0) return;
      const totalLoss = updates.reduce((s, u) => s + u.damage, 0);
      setGameState((p) => {
        if (!p) return p;
        const newWars = p.wars.map(w => {
          const u = updates.find(x => x.war.countryId === w.countryId);
          return u ? { ...w, lastBotAttack: now } : w;
        });
        return {
          ...p,
          troops: Math.max(0, p.troops - totalLoss),
          wars: newWars,
        };
      });
      for (const u of updates) {
        showNotif(`⚠️ ${u.enemyName} counter-attacks! You lose ${u.damage} troops!`);
      }
    }, 2000);
    return () => clearInterval(iv);
  }, [gameState?.playerId]);

  // ===== Bot research saving + bot wars + AI trade offers + guarantee triggers =====
  // Runs every 3 seconds.
  useEffect(() => {
    if (!gameState) return;
    const iv = setInterval(() => {
      const prev = gameStateRef.current;
      if (!prev || prev.paused) return;
      const now = Date.now();
      const nbMap = neighborsRef.current;

      setGameState((p) => {
        if (!p) return p;
        let next = { ...p };
        let countries = { ...p.countries };
        let botResearch = { ...(p.botResearch || {}) };
        let botSavings = { ...(p.botSavings || {}) };
        let wars = p.wars;
        const notifs: string[] = [];

        // ----- Bot research: each bot earmarks gold from its biggest country and researches over time
        // We model this as: each bot accumulates "savings" from its richest country (drains 5 gold/3s)
        // once savings reach cost (1000 * (lvl+1)) for a chosen branch, level up.
        for (const bot of p.bots) {
          const owned = Object.values(countries).filter(c => c.owner === bot.id);
          if (owned.length === 0) continue;
          // Skip very early game (before year 2026.5) to give "later in the game" feel
          if (p.date.year < 2026) continue;
          // Pick richest
          const richest = owned.reduce((a, b) => a.gold > b.gold ? a : b);
          if (richest.gold > 60) {
            const drain = 5;
            countries[richest.id] = { ...richest, gold: richest.gold - drain };
            botSavings[bot.id] = (botSavings[bot.id] || 0) + drain;
          }
          // Try to spend savings on lowest-level branch
          const lvls = botResearch[bot.id] || { atk: 0, def: 0, gold: 0, troop: 0 };
          const branches = ["atk", "def", "gold", "troop"] as const;
          const target = branches.reduce((a, b) => (lvls[a] <= lvls[b] ? a : b));
          if (lvls[target] < 5) {
            const cost = 1000 * (lvls[target] + 1);
            if ((botSavings[bot.id] || 0) >= cost) {
              botSavings[bot.id] -= cost;
              botResearch[bot.id] = { ...lvls, [target]: lvls[target] + 1 };
            }
          }
        }

        // ----- AI offers trade deal to player if bot owns a country in player's region (continent)
        // Random small chance per tick, only if relations >= 30 and no existing deal.
        const playerContinent = CONTINENTS[p.playerCountryId];
        for (const cid in countries) {
          const c = countries[cid];
          if (!c.owner || c.owner === "player") continue;
          if (CONTINENTS[cid] !== playerContinent) continue;
          if (c.tradeDeals.includes("player")) continue;
          const rel = c.relations.player || 0;
          if (rel < 30) continue;
          // ~2% chance per 3s tick
          if (Math.random() < 0.02) {
            countries[cid] = { ...c, tradeDeals: [...c.tradeDeals, "player"] };
            notifs.push(`💰 ${c.name} offered a trade deal — accepted! +2 gold/sec`);
          }
        }

        // ----- Guarantee independence: if a bot declares war / attacks a guaranteed country,
        // the player is dragged in. We model "bot at war with guaranteed country" via bot wars
        // (see bot vs bot below). Trigger if any guarantee target is being attacked by a bot.
        // For simplicity, if a guaranteed country has lost troops recently AND is at war below.

        // ----- Bot vs bot wars: opportunistic — strong bots attack weak neighbors
        // Requires: attacker has ≥2x troops of target AND has enough simulated "PP" (gold ≥ 150)
        // Low probability per tick so wars are occasional, not constant
        if (p.date.year >= 2026) {
          const aggressors = p.bots.filter(b => Object.values(countries).some(c => c.owner === b.id));
          for (const ag of aggressors) {
            // Each bot has only a ~8% chance per 3s tick to consider war (very occasional)
            if (Math.random() > 0.08) continue;
            const agCountries = Object.values(countries).filter(c => c.owner === ag.id);
            const agTotalTroops = agCountries.reduce((s, c) => s + c.troops, 0);
            const agRichest = agCountries.reduce((a, b) => a.gold > b.gold ? a : b, agCountries[0]);
            // Bot needs a "political power" equivalent — enough gold savings — to justify war
            if (!agRichest || agRichest.gold < 150) continue;

            outer: for (const c of agCountries) {
              const nbs = nbMap[c.id];
              if (!nbs) continue;
              for (const nbId of nbs) {
                const nb = countries[nbId];
                if (!nb || !nb.owner || nb.owner === ag.id) continue;
                if (nb.owner === "player") continue;
                if (nb.owner.startsWith("human-")) continue;
                // Only attack if aggressor has significantly more troops (2x ratio = power imbalance)
                const nbOwnerCountries = Object.values(countries).filter(cc => cc.owner === nb.owner);
                const nbTotalTroops = nbOwnerCountries.reduce((s, cc) => s + cc.troops, 0);
                if (agTotalTroops < nbTotalTroops * 2.0) continue;
                // Additional check: aggressor must be notably stronger per-country too
                if (c.troops < nb.troops * 1.5) continue;

                const force = Math.floor(c.troops * 0.75);
                const defenseMult = 1 + nb.buildings.filter(b => b.type === "fort").length * 0.02;
                const atkLvl = (botResearch[ag.id]?.atk || 0);
                const defLvl = (botResearch[nb.owner]?.def || 0);
                const atkPower = force * (1 + atkLvl * 0.1);
                const defPower = nb.troops * defenseMult * (1 + defLvl * 0.1);
                // Spend gold as "PP cost" for declaring war
                countries[agRichest.id] = { ...countries[agRichest.id], gold: agRichest.gold - 100 };
                countries[c.id] = { ...countries[c.id], troops: Math.max(50, c.troops - Math.floor(force * 0.5)) };
                if (atkPower > defPower) {
                  const looted = Math.floor(nb.gold);
                  countries[c.id] = { ...countries[c.id], gold: countries[c.id].gold + looted };
                  countries[nbId] = {
                    ...nb,
                    owner: ag.id,
                    color: ag.color,
                    gold: 0,
                    troops: Math.max(50, Math.floor(force * 0.3)),
                  };
                  notifs.push(`⚔ ${ag.name} conquered ${nb.name}!`);

                  if (p.guarantees?.includes(nbId)) {
                    const agAnyCountry = agCountries[0]?.id;
                    if (agAnyCountry && !wars.some(w => w.countryId === agAnyCountry)) {
                      wars = [...wars, { countryId: agAnyCountry, startedAt: now }];
                      notifs.push(`🛡 You guaranteed ${nb.name} — dragged into war with ${ag.name}!`);
                    }
                  }
                } else {
                  countries[nbId] = { ...nb, troops: Math.max(50, nb.troops - Math.floor(defPower * 0.2)) };
                  notifs.push(`🛡 ${nb.name} repelled ${ag.name}!`);
                }
                break outer;
              }
            }
          }
        }

        next = { ...next, countries, botResearch, botSavings, wars };
        if (notifs.length > 0) {
          for (const m of notifs) setTimeout(() => showNotif(m), 0);
        }
        return next;
      });
    }, 3000);
    return () => clearInterval(iv);
  }, [gameState?.playerId]);

  // Keyboard controls
  useEffect(() => {
  const keys = new Set<string>();
  let frame: number;

  const handleKeyDown = (e: KeyboardEvent) => {
    // Stop hotkeys from firing if you're typing in a chat or search box
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      return;
    }

    keys.add(e.key.toLowerCase());

    // Space to Pause
    if (e.key === " ") {
      e.preventDefault();
      setGameState((p) => p ? { ...p, paused: !p.paused } : p);
    }

    // Hotkeys 1-9 for Buildings
    const num = parseInt(e.key);
    if (!isNaN(num) && num >= 1 && num <= BUILDING_SLOTS.length) {
      const bt = BUILDING_SLOTS[num - 1];
      setSelectedBuilding((prev) => (prev === bt ? null : bt));
    }

    // Escape to clear everything
    if (e.key === "Escape") {
      setSelectedBuilding(null);
      setContextMenu(null);
      setInspecting(null);
    }
  };

  const handleKeyUp = (e: KeyboardEvent) => {
    keys.delete(e.key.toLowerCase());
  };

  window.addEventListener("keydown", handleKeyDown);
  window.addEventListener("keyup", handleKeyUp);

  const loop = () => {
    if (svgRef.current) {
      const svg = d3.select(svgRef.current);
      const zoom = (svgRef.current as any).__zoomBehavior;
      
      if (zoom) {
        let dx = 0, dy = 0;
        // Shift key makes the camera move 3x faster
        const baseSpeed = 12;
        const speed = keys.has("shift") ? baseSpeed * 3 : baseSpeed;

        if (keys.has("w") || keys.has("arrowup")) dy = speed;
        if (keys.has("s") || keys.has("arrowdown")) dy = -speed;
        if (keys.has("a") || keys.has("arrowleft")) dx = speed;
        if (keys.has("d") || keys.has("arrowright")) dx = -speed;

        if (dx !== 0 || dy !== 0) {
          // Applying the translation to the D3 zoom state
          svg.transition().duration(0).call(zoom.translateBy, dx, dy);
        }
      }
    }
    frame = requestAnimationFrame(loop);
  };
  
  frame = requestAnimationFrame(loop);

  return () => {
    window.removeEventListener("keydown", handleKeyDown);
    window.removeEventListener("keyup", handleKeyUp);
    cancelAnimationFrame(frame);
  };
}, [setGameState]); // Added setGameState to deps for safety

  // Click handler
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (contextMenu) { setContextMenu(null); return; }
      const target = (e.target as SVGElement).closest("path.country");
      if (!target || !gameState) return;
      const id = target.getAttribute("data-id") || "";
      const country = gameState.countries[id];
      if (!country) return;

      // Building placement
      if (selectedBuilding && country.owner === "player") {
        const def = BUILDING_DEFS[selectedBuilding];
        if (def.requiresCoast && country.isCoastal === false) {
          showNotif(`${def.label} requires a coastal country!`);
          return;
        }
        const mult = buildMultiplier;
        const totalCost = def.cost * mult;
        if (gameState.gold < totalCost) {
          showNotif(`Not enough gold! Need ${totalCost} for x${mult}`);
          return;
        }
        const gNode = svgRef.current?.querySelector("g.map-group") as SVGGElement | null;
        let baseX: number | undefined;
        let baseY: number | undefined;
        if (gNode) {
          const [lx, ly] = d3.pointer(e.nativeEvent, gNode);
          baseX = lx;
          baseY = ly;
        }
        const entries: { type: BuildingType; icon: string; x?: number; y?: number }[] = [];
        for (let i = 0; i < mult; i++) {
          // Spread copies in a small spiral so they're visible separately
          const angle = (i / Math.max(1, mult)) * Math.PI * 2;
          const radius = i === 0 ? 0 : 6 + (i % 3) * 4;
          const ex = baseX !== undefined ? baseX + Math.cos(angle) * radius : undefined;
          const ey = baseY !== undefined ? baseY + Math.sin(angle) * radius : undefined;
          entries.push({ type: selectedBuilding, icon: def.icon, x: ex, y: ey });
        }
        setGameState((prev) => {
          if (!prev) return prev;
          const c = { ...prev.countries[id] };
          c.buildings = [...c.buildings, ...entries];
          return {
            ...prev,
            gold: prev.gold - totalCost,
            countries: { ...prev.countries, [id]: c },
          };
        });
        for (const en of entries) {
          mpBroadcast({ type: "build", from: myOwnerKeyRef.current, countryId: id, building: en });
        }
        showNotif(`${def.icon} ×${mult} ${def.label} placed in ${country.name}!`);
        if (mult === 1) setSelectedBuilding(null);
        return;
      }
    },
    [gameState, selectedBuilding, contextMenu, buildMultiplier, mpBroadcast]
  );

  // Right-click
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const target = (e.target as SVGElement).closest("path.country");
      if (!target || !gameState) return;
      const id = target.getAttribute("data-id") || "";
      const country = gameState.countries[id];
      if (!country || country.owner === "player") return;
      setContextMenu({ x: e.clientX, y: e.clientY, countryId: id });
    },
    [gameState]
  );

  const showNotif = (msg: string) => {
    setNotification(msg);
    setTimeout(() => setNotification(null), 2500);
    setGameState((prev) => {
      if (!prev) return prev;
      const entry = { id: Date.now() + Math.random(), message: msg, timestamp: Date.now() };
      const notifications = [entry, ...prev.notifications].slice(0, 100);
      return { ...prev, notifications };
    });
  };

  // PP costs for diplomatic actions
  const PP_COSTS: Record<string, number> = {
    improve: 15,
    trade: 10,
    guarantee: 15,
    diplomat: 100,
    ally: 25,
    breakAlliance: 15,
    justify: 30,
    declareWar: 50,
  };

  const handleDiplomacy = (action: string) => {
    if (!contextMenu || !gameState) return;
    const c = gameState.countries[contextMenu.countryId];
    if (!c) return;

    if (action !== "inspect") {
      const cost = PP_COSTS[action] ?? 0;
      if (gameState.politicalPower < cost) {
        showNotif(`Not enough Political Power! Need ${cost} PP`);
        setContextMenu(null);
        return;
      }
    }

    switch (action) {
      case "inspect":
        setInspecting(contextMenu.countryId);
        break;
      case "improve":
        setGameState((prev) => {
          if (!prev) return prev;
          const country = { ...prev.countries[contextMenu.countryId] };
          country.relations = { ...country.relations, player: (country.relations.player || 0) + 10 };
          return { ...prev, politicalPower: prev.politicalPower - PP_COSTS.improve, countries: { ...prev.countries, [contextMenu.countryId]: country } };
        });
        showNotif(`Relations improved with ${c.name} (+10) — −${PP_COSTS.improve} PP`);
        break;
      case "trade":
        if (gameState.gold < 50) { showNotif("Need 50 gold for trade deal!"); break; }
        setGameState((prev) => {
          if (!prev) return prev;
          const country = { ...prev.countries[contextMenu.countryId] };
          if (country.tradeDeals.includes("player")) { showNotif("Already have trade deal!"); return prev; }
          country.tradeDeals = [...country.tradeDeals, "player"];
          return { ...prev, gold: prev.gold - 50, politicalPower: prev.politicalPower - PP_COSTS.trade, countries: { ...prev.countries, [contextMenu.countryId]: country } };
        });
        showNotif(`Trade deal with ${c.name}! +2 gold/sec — −${PP_COSTS.trade} PP`);
        break;
      case "guarantee":
        setGameState((prev) => prev ? {
          ...prev,
          politicalPower: prev.politicalPower - PP_COSTS.guarantee,
          guarantees: prev.guarantees?.includes(contextMenu.countryId) ? prev.guarantees : [...(prev.guarantees || []), contextMenu.countryId],
        } : prev);
        showNotif(`🛡 Guaranteed independence of ${c.name} — −${PP_COSTS.guarantee} PP. You will be dragged into war if attacked.`);
        break;
      case "diplomat":
        setGameState((prev) => {
          if (!prev) return prev;
          const country = { ...prev.countries[contextMenu.countryId] };
          country.diplomatUntil = Date.now() + 100000; // 100 seconds
          return {
            ...prev,
            politicalPower: prev.politicalPower - PP_COSTS.diplomat,
            countries: { ...prev.countries, [contextMenu.countryId]: country },
          };
        });
        showNotif(`📨 Diplomat sent to ${c.name}: +1 relation/sec for 100s — −${PP_COSTS.diplomat} PP`);
        break;
      case "ally": {
        const ownerId = c.owner;
        if (!ownerId) {
          showNotif(`${c.name} is unowned — cannot ally.`);
          break;
        }
        if (gameState.alliances.includes(ownerId)) {
          showNotif(`Already allied with ${c.name}!`);
          break;
        }
        // Use functional updater to get the latest relations
        setGameState((prev) => {
          if (!prev) return prev;
          const latest = prev.countries[contextMenu.countryId];
          const rel = latest?.relations?.player || 0;
          if (rel < 70) {
            showNotif(`❌ ${c.name} rejected the alliance. Need 70+ relations (current: ${rel})`);
            return prev;
          }
          if (prev.alliances.includes(ownerId)) return prev; // double-check
          showNotif(`✅ ${c.name} accepted the alliance! (relations ${rel}) — −${PP_COSTS.ally} PP`);
          return { ...prev, politicalPower: prev.politicalPower - PP_COSTS.ally, alliances: [...prev.alliances, ownerId] };
        });
        break;
      }
      case "breakAlliance": {
        const ownerId = c.owner;
        if (!ownerId || !gameState.alliances.includes(ownerId)) {
          showNotif(`Not allied with ${c.name}.`);
          break;
        }
        setGameState((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            politicalPower: prev.politicalPower - PP_COSTS.breakAlliance,
            alliances: prev.alliances.filter((a) => a !== ownerId),
          };
        });
        showNotif(`💔 Alliance with ${c.name} broken — −${PP_COSTS.breakAlliance} PP`);
        break;
      }
      case "justify": {
        if (gameState.warGoals.includes(contextMenu.countryId)) {
          showNotif(`War goal already justified on ${c.name}.`);
          break;
        }
        if (c.owner && gameState.alliances.includes(c.owner)) {
          showNotif(`Cannot justify war on an ally — break the alliance first!`);
          break;
        }
        setGameState((prev) => {
          if (!prev) return prev;
          const country = { ...prev.countries[contextMenu.countryId] };
          country.relations = { ...country.relations, player: (country.relations.player || 0) - 20 };
          return {
            ...prev,
            politicalPower: prev.politicalPower - PP_COSTS.justify,
            warGoals: [...prev.warGoals, contextMenu.countryId],
            countries: { ...prev.countries, [contextMenu.countryId]: country },
          };
        });
        showNotif(`📜 War goal justified on ${c.name} (−20 relations) — −${PP_COSTS.justify} PP`);
        break;
      }
      case "declareWar": {
        if (c.owner && gameState.alliances.includes(c.owner)) {
          showNotif(`Cannot declare war on an ally — break the alliance first!`);
          break;
        }
        if (!gameState.warGoals.includes(contextMenu.countryId)) {
          showNotif(`Justify a war goal on ${c.name} first!`);
          break;
        }
        if (isAtWar(gameState.wars, contextMenu.countryId)) {
          showNotif(`Already at war with ${c.name}.`);
          break;
        }
        setGameState((prev) => {
          if (!prev) return prev;
          const country = { ...prev.countries[contextMenu.countryId] };
          country.relations = { ...country.relations, player: (country.relations.player || 0) - 80 };
          return {
            ...prev,
            politicalPower: prev.politicalPower - PP_COSTS.declareWar,
            wars: [...prev.wars, { countryId: contextMenu.countryId, startedAt: Date.now() }],
            countries: { ...prev.countries, [contextMenu.countryId]: country },
          };
        });
        // Broadcast war declaration if target is owned by another human
        if (c.owner && c.owner.startsWith("human-")) {
          mpBroadcast({
            type: "war_declared",
            from: myOwnerKeyRef.current,
            fromName: myNameRef.current,
            to: c.owner,
            targetCountryId: contextMenu.countryId,
          });
        }
        showNotif(`⚔ WAR DECLARED on ${c.name}! Relations −80 — −${PP_COSTS.declareWar} PP`);
        break;
      }
      case "attack": {
         if (!isAtWar(gameState.wars, contextMenu.countryId)) {
          showNotif(`You are not at war with ${c.name}.`);
          break;
        }
        setAttackTarget(contextMenu.countryId);
        setAttackTroops(Math.min(Math.floor(gameState.troops), Math.max(100, Math.floor(gameState.troops / 2))));
        setAttackTanks(Math.floor(gameState.tanks));
        setAttackPlanes(Math.floor(gameState.planes));
        break;
      }
      case "makePeace": {
        if (!isAtWar(gameState.wars, contextMenu.countryId)) {
          showNotif(`Not at war with ${c.name}.`);
          break;
        }
        setGameState((prev) => {
          if (!prev) return prev;
          const country = { ...prev.countries[contextMenu.countryId] };
          country.relations = { ...country.relations, player: Math.min((country.relations.player || 0) + 30, 0) };
          return {
            ...prev,
            politicalPower: prev.politicalPower - 20,
            wars: removeWar(prev.wars, contextMenu.countryId),
            warGoals: prev.warGoals.filter((w) => w !== contextMenu.countryId),
            countries: { ...prev.countries, [contextMenu.countryId]: country },
          };
        });
        if (c.owner && c.owner.startsWith("human-")) {
          mpBroadcast({
            type: "war_ended",
            from: myOwnerKeyRef.current,
            fromName: myNameRef.current,
            to: c.owner,
            targetCountryId: contextMenu.countryId,
          });
        }
        showNotif(`🕊 Peace made with ${c.name}! Relations restored partially. −20 PP`);
        break;
      }
      case "requestTroops": {
        const ownerId = c.owner;
        if (!ownerId || !gameState.alliances.includes(ownerId)) {
          showNotif(`${c.name} is not your ally.`);
          break;
        }
        if (lastTroopRequestYear >= gameState.date.year) {
          showNotif(`You can only request troops once per year! Wait until ${gameState.date.year + 1}.`);
          break;
        }
        const rel = c.relations.player || 0;
        // Chance based on relations: min 10%, max 90%, scales from 0 to 200 relations
        const chance = Math.min(0.9, Math.max(0.1, rel / 220));
        const roll = Math.random();
        if (roll < chance) {
          const troopsGained = Math.floor(c.troops * 0.05);
          setGameState((prev) => {
            if (!prev) return prev;
            const country = { ...prev.countries[contextMenu.countryId] };
            country.troops = Math.max(0, country.troops - troopsGained);
            return {
              ...prev,
              troops: prev.troops + troopsGained,
              countries: { ...prev.countries, [contextMenu.countryId]: country },
            };
          });
          setLastTroopRequestYear(gameState.date.year);
          showNotif(`✅ ${c.name} sent ${troopsGained} troops! (${Math.round(chance * 100)}% chance)`);
        } else {
          setLastTroopRequestYear(gameState.date.year);
          showNotif(`❌ ${c.name} refused to send troops. (${Math.round(chance * 100)}% chance, rolled ${Math.round(roll * 100)}%)`);
        }
        break;
      }
    }
    setContextMenu(null);
  };

  // AI Advisor
  const sendAdvisorMsg = async () => {
    if (!advisorInput.trim() || !gameState) return;
    const userMsg = { role: "user", content: advisorInput };
    setAdvisorMessages((p) => [...p, userMsg]);
    setAdvisorInput("");
    setAdvisorLoading(true);

    const playerCountries = Object.values(gameState.countries).filter(c => c.owner === "player");
    const gameContext = {
      date: formatDate(gameState.date),
      playerCountry: getCountryName(gameState.playerCountryId),
      gold: Math.floor(gameState.gold),
      troops: Math.floor(gameState.troops),
      buildings: playerCountries.flatMap(c => c.buildings.map(b => b.type)),
      ownedCountries: playerCountries.map(c => c.name),
    };

    try {
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/strategy-advisor`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
          body: JSON.stringify({
            messages: [...advisorMessages, userMsg],
            gameState: gameContext,
          }),
        }
      );
      if (!resp.ok || !resp.body) throw new Error("Failed");

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.startsWith("data: ")) continue;
          const json = line.slice(6).trim();
          if (json === "[DONE]") break;
          try {
            const parsed = JSON.parse(json);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              assistantText += content;
              setAdvisorMessages((p) => {
                const last = p[p.length - 1];
                if (last?.role === "assistant") {
                  return [...p.slice(0, -1), { ...last, content: assistantText }];
                }
                return [...p, { role: "assistant", content: assistantText }];
              });
            }
          } catch {}
        }
      }
    } catch (e) {
      setAdvisorMessages((p) => [...p, { role: "assistant", content: "Sorry, advisor unavailable." }]);
    }
    setAdvisorLoading(false);
  };

  if (!gameState) {
    return <div className="w-full h-full flex items-center justify-center text-white">Loading map data...</div>;
  }

  const leaderboard = getLeaderboard(gameState);
  const visibleLeaderboard = showFullLeaderboard ? leaderboard : leaderboard.slice(0, 4);
  const playerEntry = leaderboard.find((l) => l.id === "player");
  const goldRate = getGoldRate(gameState);
  const troopRate = getTroopRate(gameState);
  const ppRate = getPoliticalPowerRate(gameState);
  const inspectCountry = inspecting ? gameState.countries[inspecting] : null;
  const ctxCountry = contextMenu ? gameState.countries[contextMenu.countryId] : null;

  return (
    <div className="relative w-full h-full" onClick={() => { if (contextMenu) setContextMenu(null); }}>
      {/* Map SVG */}
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        className="bg-[#1a1f2e]"
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        style={{ cursor: selectedBuilding ? "crosshair" : "grab" }}
      >
        <g className="map-group" />
      </svg>

      {/* Vignette */}
      <div className="absolute inset-0 pointer-events-none" style={{
        background: "radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.4) 100%)"
      }} />

      {/* Date display - top center */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 bg-[#0f1420]/90 backdrop-blur-sm px-4 py-2 rounded-full border border-[#4a5568]">
        <button
          onClick={() => setGameState(p => p ? { ...p, speed: Math.max(1, p.speed - 1) } : p)}
          className="text-gray-400 hover:text-white px-1"
        >◀</button>
        <button
          onClick={() => setGameState(p => p ? { ...p, paused: !p.paused } : p)}
          className="text-white hover:text-[#f97316] px-1 text-lg"
        >{gameState.paused ? "▶" : "⏸"}</button>
        <span className="text-white font-mono text-sm min-w-[160px] text-center">
          {formatDate(gameState.date)}
        </span>
        <span className="text-[#f97316] text-xs">×{gameState.speed}</span>
        <button
          onClick={() => setGameState(p => p ? { ...p, speed: Math.min(5, p.speed + 1) } : p)}
          className="text-gray-400 hover:text-white px-1"
        >▶</button>
      </div>

      {/* Leaderboard - top left */}
      <div className="absolute top-3 left-3 z-20 bg-[#0f1420]/90 backdrop-blur-sm rounded-lg border border-[#4a5568] p-3 min-w-[280px]">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs text-gray-400 font-bold uppercase tracking-wider">Leaderboard</div>
          <button
            onClick={() => setShowFullLeaderboard((v) => !v)}
            className="text-[10px] text-[#f97316] hover:text-[#fb923c] font-semibold uppercase tracking-wider"
          >
            {showFullLeaderboard ? "Show less ▲" : `Show more (${leaderboard.length}) ▼`}
          </button>
        </div>
        <div
          className={showFullLeaderboard ? "max-h-[320px] overflow-y-auto pr-1" : ""}
          style={showFullLeaderboard ? { scrollbarWidth: "thin" } : undefined}
        >
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-[#0f1420]">
              <tr className="text-gray-500">
                <th className="text-left w-6">#</th>
                <th className="text-left">Country</th>
                <th className="text-right">Gold</th>
                <th className="text-right">Troops</th>
              </tr>
            </thead>
            <tbody>
              {visibleLeaderboard.map((entry) => (
                <tr key={entry.id} className={entry.id === "player" ? "text-[#a78bfa]" : "text-gray-300"}>
                  <td>{entry.rank}</td>
                  <td className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: entry.color }} />
                    <span className="truncate max-w-[120px]">{entry.name}</span>
                  </td>
                  <td className="text-right">{Math.floor(entry.gold)}</td>
                  <td className="text-right">{Math.floor(entry.troops)}</td>
                </tr>
              ))}
              {!showFullLeaderboard && playerEntry && !visibleLeaderboard.some((t) => t.id === "player") && (
                <tr className="text-[#a78bfa] border-t border-[#4a5568]">
                  <td>{playerEntry.rank}</td>
                  <td className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: PLAYER_COLOR }} />
                    You
                  </td>
                  <td className="text-right">{Math.floor(playerEntry.gold)}</td>
                  <td className="text-right">{Math.floor(playerEntry.troops)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Stats - bottom left (DO NOT MOVE: troops & gold stay here) */}
      <div className="absolute bottom-20 left-3 z-20 bg-[#0f1420]/90 backdrop-blur-sm rounded-lg border border-[#4a5568] p-3 min-w-[220px]">
        <div className="text-sm text-white mb-1">
          ⚔ Troops: <span className="font-bold">{Math.floor(gameState.troops)}</span>
          <span className="text-green-400 text-xs ml-1">+{troopRate}/s</span>
        </div>
        <div className="text-sm text-white mb-1">
          🚜 Tanks: <span className="font-bold">{Math.floor(gameState.tanks)}</span>
          <span className="text-yellow-400 text-xs ml-1">factories</span>
        </div>
        <div className="text-sm text-white mb-1">
          ✈ Planes: <span className="font-bold">{Math.floor(gameState.planes)}</span>
          <span className="text-cyan-400 text-xs ml-1">air bases</span>
        </div>
        <div className="text-sm text-white mb-1">
          💰 Gold: <span className="font-bold">{Math.floor(gameState.gold)}</span>
          <span className="text-green-400 text-xs ml-1">+{goldRate}/s</span>
        </div>
        <div className="text-sm text-white">
          🎖 Political Power: <span className="font-bold">{Math.floor(gameState.politicalPower)}</span>
          <span className="text-green-400 text-xs ml-1">+{ppRate.toFixed(1)}/s</span>
        </div>
      </div>

      {/* Allies panel - directly under troops/gold/PP */}
      {gameState.alliances.length > 0 && (
        <div className="absolute bottom-3 left-3 z-20 bg-[#0f1420]/90 backdrop-blur-sm rounded-lg border border-cyan-500/50 p-2 min-w-[220px] max-h-[120px] overflow-y-auto">
          <div className="text-xs text-cyan-400 mb-1 font-bold uppercase tracking-wider">🕊 Allies ({gameState.alliances.length})</div>
          <div className="space-y-1">
            {gameState.alliances.map((allyId) => {
              const bot = gameState.bots.find((b) => b.id === allyId);
              if (!bot) return null;
              return (
                <div key={allyId} className="flex items-center gap-2 text-xs text-gray-200">
                  <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: bot.color }} />
                  <span className="truncate">{bot.name}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Hotbar - bottom center */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 flex items-end gap-2">
        <div className="flex gap-1">
          {BUILDING_SLOTS.map((bt, i) => {
            const def = BUILDING_DEFS[bt];
            const isSelected = selectedBuilding === bt;
            return (
              <button
                key={bt}
                onClick={(e) => { e.stopPropagation(); setSelectedBuilding(isSelected ? null : bt); }}
                className={`w-14 h-14 rounded-lg flex flex-col items-center justify-center text-xs transition border ${
                  isSelected
                    ? "bg-[#7c3aed] border-[#a78bfa] text-white"
                    : "bg-[#0f1420]/90 border-[#4a5568] text-gray-300 hover:bg-[#1a2030]"
                }`}
                title={`${def.label} — ${def.cost * buildMultiplier} gold (×${buildMultiplier}) — ${def.description}`}
              >
                <span className="text-lg">{def.icon}</span>
                <span className="text-[10px]">{i + 1}</span>
              </button>
            );
          })}
        </div>
        {/* Build multiplier x1/x5/x10 */}
        <div className="flex flex-col gap-1 ml-1">
          {([1, 5, 10] as const).map((m) => (
            <button
              key={m}
              onClick={(e) => { e.stopPropagation(); setBuildMultiplier(m); }}
              className={`w-10 h-[17px] rounded text-[10px] font-bold border transition ${
                buildMultiplier === m
                  ? "bg-[#f97316] border-[#fb923c] text-white"
                  : "bg-[#0f1420]/90 border-[#4a5568] text-gray-400 hover:bg-[#1a2030]"
              }`}
              title={`Place ${m} building${m > 1 ? "s" : ""} per click`}
            >×{m}</button>
          ))}
        </div>
      </div>

      {/* Side rail - right middle: Research, Goals, Notifications */}
      <div className="absolute top-1/2 right-3 -translate-y-1/2 z-20 flex flex-col gap-2">
        <button
          onClick={() => setShowResearch((v) => !v)}
          title="Research"
          className="w-12 h-12 rounded-lg bg-[#0f1420]/90 border border-[#4a5568] text-white text-xl hover:bg-[#1a2030] flex items-center justify-center"
        >🔬</button>
        <button
          onClick={() => setShowGoals((v) => !v)}
          title="Goals"
          className="w-12 h-12 rounded-lg bg-[#0f1420]/90 border border-[#4a5568] text-white text-xl hover:bg-[#1a2030] flex items-center justify-center relative"
        >
          🏆
          {GOALS.length - gameState.completedGoals.length > 0 && (
            <span className="absolute -top-1 -right-1 bg-[#f97316] text-white text-[9px] rounded-full w-4 h-4 flex items-center justify-center font-bold">
              {GOALS.length - gameState.completedGoals.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setShowNotifLog((v) => !v)}
          title="Notification history"
          className="w-12 h-12 rounded-lg bg-[#0f1420]/90 border border-[#4a5568] text-white text-xl hover:bg-[#1a2030] flex items-center justify-center"
        >🔔</button>
        <button
          onClick={() => setShowFormables((v) => !v)}
          title="Formable nations"
          className="w-12 h-12 rounded-lg bg-[#0f1420]/90 border border-[#4a5568] text-white text-xl hover:bg-[#1a2030] flex items-center justify-center relative"
        >
          🏛
          {(() => {
            const ready = FORMABLES.filter(f => !(gameState.formedNations || []).includes(f.id) && f.requiredCountryIds.every(id => gameState.countries[id]?.owner === "player")).length;
            return ready > 0 ? (
              <span className="absolute -top-1 -right-1 bg-green-500 text-white text-[9px] rounded-full w-4 h-4 flex items-center justify-center font-bold">{ready}</span>
            ) : null;
          })()}
        </button>
      </div>

      {/* Formables panel */}
      {showFormables && (
        <div className="absolute top-1/2 right-20 -translate-y-1/2 z-30 w-80 bg-[#0f1420]/95 border border-[#4a5568] rounded-xl p-4 max-h-[70vh] overflow-y-auto">
          <div className="flex justify-between items-center mb-3">
            <h3 className="text-white font-bold">🏛 Formable Nations</h3>
            <button onClick={() => setShowFormables(false)} className="text-gray-400 hover:text-white">✕</button>
          </div>
          <div className="text-[11px] text-gray-400 mb-2">Own every required country, then spend Political Power to form a unified nation. Recolors all member countries.</div>
          <div className="space-y-2">
            {FORMABLES.map((f) => {
              const formed = (gameState.formedNations || []).includes(f.id);
              const owned = f.requiredCountryIds.filter(id => gameState.countries[id]?.owner === "player").length;
              const total = f.requiredCountryIds.length;
              const ready = owned === total && !formed;
              const canAfford = gameState.politicalPower >= f.ppCost;
              return (
                <div key={f.id} className={`p-2 rounded border ${formed ? "border-green-500/50 bg-green-900/20" : ready ? "border-yellow-400/60 bg-yellow-900/10" : "border-[#4a5568] bg-[#1a2030]"}`}>
                  <div className="flex justify-between items-start gap-2">
                    <div className="flex-1">
                      <div className="text-sm text-white font-bold">{f.flag} {f.name} {formed && "✅"}</div>
                      <div className="text-[10px] text-cyan-400">{owned}/{total} owned · cost {f.ppCost} PP</div>
                    </div>
                    <button
                      disabled={formed || !ready || !canAfford}
                      onClick={() => {
                        setGameState((prev) => {
                          if (!prev) return prev;
                          if ((prev.formedNations || []).includes(f.id)) return prev;
                          if (!f.requiredCountryIds.every(id => prev.countries[id]?.owner === "player")) return prev;
                          if (prev.politicalPower < f.ppCost) return prev;
                          const newCountries = { ...prev.countries };
                          for (const id of f.requiredCountryIds) {
                            if (newCountries[id]) {
                              newCountries[id] = { ...newCountries[id], color: f.color };
                            }
                          }
                          return {
                            ...prev,
                            politicalPower: prev.politicalPower - f.ppCost,
                            formedNations: [...(prev.formedNations || []), f.id],
                            countries: newCountries,
                          };
                        });
                        showNotif(`🏛 ${f.name} FORMED! All member territories unified.`);
                      }}
                      className="px-2 py-1 rounded bg-yellow-600 hover:bg-yellow-500 text-white text-xs font-bold disabled:opacity-30 disabled:cursor-not-allowed"
                    >{formed ? "Formed" : ready ? (canAfford ? "Form!" : "Need PP") : "Locked"}</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* AI Advisor button - bottom right */}
      <div className="absolute bottom-3 right-3 z-20">
        <button
          onClick={() => setShowAdvisor(!showAdvisor)}
          className="px-4 py-2 rounded-lg bg-[#f97316] text-white font-bold hover:bg-[#ea580c] transition text-sm"
        >
          🧠 AI Advisor
        </button>
      </div>

      {/* Research panel */}
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
                <div className="w-full h-2 bg-[#0f1420] rounded mt-1">
                  <div className="h-full bg-cyan-500 rounded" style={{ width: `${pct}%` }} />
                </div>
                <div className="text-[10px] text-gray-400 text-right">{Math.ceil((def.durationMs - elapsed) / 1000)}s left</div>
              </div>
            );
          })()}
          <div className="text-[11px] text-gray-400 mb-2">Each branch can be researched up to 5 times (+10% per level, max +50%).</div>
          <div className="space-y-2">
            {RESEARCH_DEFS.map((r) => {
              const lvl = gameState.researchLevels?.[r.id] || 0;
              const maxed = lvl >= 5;
              const isActive = gameState.activeResearch?.id === r.id;
              const cost = r.cost * (lvl + 1); // each level costs more
              const canStart = !maxed && !gameState.activeResearch && gameState.gold >= cost;
              return (
                <div key={r.id} className={`p-2 rounded border ${maxed ? "border-green-500/50 bg-green-900/20" : "border-[#4a5568] bg-[#1a2030]"}`}>
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="text-sm text-white font-bold">{r.label} <span className="text-cyan-400">Lv {lvl}/5</span> {maxed && "✅"}</div>
                      <div className="text-[10px] text-gray-400">{r.description} · current: +{lvl * 10}%</div>
                      <div className="text-[10px] text-yellow-400">{cost}g · {r.durationMs / 1000}s</div>
                    </div>
                    <button
                      disabled={!canStart || isActive}
                      onClick={() => {
                        setGameState((prev) => prev ? {
                          ...prev,
                          gold: prev.gold - cost,
                          activeResearch: { id: r.id, startedAt: Date.now() },
                        } : prev);
                        showNotif(`🔬 Researching ${r.label} Lv ${lvl + 1}...`);
                      }}
                      className="px-2 py-1 rounded bg-cyan-700 hover:bg-cyan-600 text-white text-xs disabled:opacity-30"
                    >{maxed ? "Max" : isActive ? "Active" : `Lv ${lvl + 1}`}</button>
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
            {GOALS.map((g) => {
              const done = gameState.completedGoals.includes(g.id);
              let progress = "";
              if (g.id === "continent") {
                const cont = CONTINENTS[gameState.playerCountryId];
                if (cont) {
                  const inCont = Object.keys(CONTINENTS).filter(id => CONTINENTS[id] === cont && gameState.countries[id]);
                  const owned = inCont.filter(id => gameState.countries[id]?.owner === "player").length;
                  progress = `${owned}/${inCont.length} (${CONTINENT_NAMES[cont]})`;
                }
              } else if (g.id === "ten") {
                const c = Object.values(gameState.countries).filter(c => c.owner === "player").length;
                progress = `${c}/10`;
              } else if (g.id === "twentyfive") {
                const c = Object.values(gameState.countries).filter(c => c.owner === "player").length;
                progress = `${c}/25`;
              }
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
          {gameState.notifications.length === 0 ? (
            <div className="text-xs text-gray-500 text-center py-4">No notifications yet.</div>
          ) : (
            <div className="space-y-1">
              {gameState.notifications.map((n) => (
                <div key={n.id} className="text-xs text-gray-300 p-2 bg-[#1a2030] rounded">
                  <div>{n.message}</div>
                  <div className="text-[9px] text-gray-500 mt-0.5">{new Date(n.timestamp).toLocaleTimeString()}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Advisor panel */}
      {showAdvisor && (
        <div className="absolute bottom-14 right-3 z-30 w-80 h-96 bg-[#0f1420]/95 backdrop-blur-md border border-[#4a5568] rounded-xl flex flex-col overflow-hidden">
          <div className="p-3 border-b border-[#4a5568] flex justify-between items-center">
            <span className="text-white font-bold text-sm">🧠 Strategy Advisor</span>
            <button onClick={() => setShowAdvisor(false)} className="text-gray-400 hover:text-white">✕</button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {advisorMessages.length === 0 && (
              <div className="text-gray-500 text-xs text-center mt-8">Ask your advisor for strategic guidance...</div>
            )}
            {advisorMessages.map((m, i) => (
              <div key={i} className={`text-xs p-2 rounded ${m.role === "user" ? "bg-[#7c3aed]/30 text-white ml-4" : "bg-[#2d3b2d]/50 text-gray-200 mr-4"}`}>
                {m.content}
              </div>
            ))}
          </div>
          <div className="p-2 border-t border-[#4a5568] flex gap-2">
            <input
              value={advisorInput}
              onChange={(e) => setAdvisorInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendAdvisorMsg()}
              placeholder="Ask for advice..."
              className="flex-1 px-2 py-1 rounded bg-[#1a2030] text-white text-xs border border-[#4a5568] focus:outline-none"
            />
            <button
              onClick={sendAdvisorMsg}
              disabled={advisorLoading}
              className="px-3 py-1 rounded bg-[#f97316] text-white text-xs font-bold disabled:opacity-50"
            >
              {advisorLoading ? "..." : "Send"}
            </button>
          </div>
        </div>
      )}

      {/* Context menu */}
      {contextMenu && ctxCountry && (
        <div
          className="fixed z-40 bg-[#0f1420]/95 backdrop-blur-md border border-[#4a5568] rounded-xl py-2 min-w-[220px] shadow-2xl overflow-y-auto overscroll-contain"
          style={{
            left: Math.min(contextMenu.x, window.innerWidth - 240),
            top: Math.min(contextMenu.y, Math.max(8, window.innerHeight - 380)),
            maxHeight: Math.min(window.innerHeight - 16, 480),
          }}
          onClick={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1 text-white font-bold text-sm border-b border-[#4a5568] mb-1">
            {getCountryFlag(contextMenu.countryId)} {ctxCountry.name}
          </div>
          <button onClick={() => handleDiplomacy("inspect")} className="w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-[#2d3b2d] flex items-center gap-2">
            👁 Inspect
          </button>
          <button onClick={() => handleDiplomacy("improve")} className="w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-[#2d3b2d] flex items-center gap-2">
            🤝 Improve Relations
          </button>
          {(() => {
            const isAlly = !!(ctxCountry.owner && gameState.alliances.includes(ctxCountry.owner));
            const hasGoal = gameState.warGoals.includes(contextMenu.countryId);
            const atWar = isAtWar(gameState.wars, contextMenu.countryId);
            return (
              <>
                <button
                  onClick={() => handleDiplomacy("justify")}
                  disabled={isAlly || hasGoal || atWar}
                  className="w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 disabled:text-gray-500 disabled:cursor-not-allowed text-gray-200 hover:bg-[#2d3b2d]"
                  title={isAlly ? "Break alliance first" : hasGoal ? "Already justified" : `Costs ${PP_COSTS.justify} PP`}
                >
                  📜 Justify War Goal {hasGoal ? "✅" : `(${PP_COSTS.justify} PP)`}
                </button>
                <button onClick={() => handleDiplomacy("guarantee")} className="w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-[#2d3b2d] flex items-center gap-2">
                  🛡 Guarantee Independence
                </button>
                <button onClick={() => handleDiplomacy("trade")} className="w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-[#2d3b2d] flex items-center gap-2">
                  💰 Request Trade Deal
                </button>
                <button onClick={() => handleDiplomacy("diplomat")} className="w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-[#2d3b2d] flex items-center gap-2">
                  📨 Send Diplomat
                </button>
                {isAlly ? (
                  <>
                    <button onClick={() => handleDiplomacy("breakAlliance")} className="w-full px-3 py-1.5 text-left text-sm text-orange-300 hover:bg-[#2d3b2d] flex items-center gap-2">
                      💔 Break Alliance ({PP_COSTS.breakAlliance} PP)
                    </button>
                    <button onClick={() => handleDiplomacy("requestTroops")} className="w-full px-3 py-1.5 text-left text-sm text-cyan-300 hover:bg-[#2d3b2d] flex items-center gap-2">
                      🪖 Request Troops (yearly)
                    </button>
                  </>
                ) : (
                  <button onClick={() => handleDiplomacy("ally")} className="w-full px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-[#2d3b2d] flex items-center gap-2">
                    🕊 Request Alliance (rel {ctxCountry.relations.player || 0}/70)
                  </button>
                )}
                <div className="border-t border-[#4a5568] mt-1 pt-1">
                  {atWar ? (
                    <>
                      <button onClick={() => handleDiplomacy("attack")} className="w-full px-3 py-1.5 text-left text-sm text-red-400 hover:bg-[#2d3b2d] flex items-center gap-2 font-bold">
                        ⚔ Attack!
                      </button>
                      <button onClick={() => handleDiplomacy("makePeace")} className="w-full px-3 py-1.5 text-left text-sm text-green-400 hover:bg-[#2d3b2d] flex items-center gap-2">
                        🕊 Make Peace (20 PP)
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => handleDiplomacy("declareWar")}
                      disabled={isAlly || !hasGoal}
                      className="w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 disabled:text-gray-500 disabled:cursor-not-allowed text-red-400 hover:bg-[#2d3b2d]"
                      title={isAlly ? "Break alliance first" : !hasGoal ? "Justify a war goal first" : `Costs ${PP_COSTS.declareWar} PP`}
                    >
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
        <div className="absolute top-3 right-3 z-30 w-72 bg-[#0f1420]/95 backdrop-blur-md border border-[#4a5568] rounded-xl p-4">
          <div className="flex justify-between items-center mb-3">
            <h3 className="text-white font-bold">{getCountryFlag(inspecting)} {inspectCountry.name}</h3>
            <button onClick={() => setInspecting(null)} className="text-gray-400 hover:text-white">✕</button>
          </div>
          {(() => {
            const mult = effectiveMult(inspecting!);
            const cityCount = inspectCountry.buildings.filter(b => b.type === "city").length;
            // factories no longer produce troops
            // Per-second rates (tick is 100ms, so multiply per-tick gain by 10)
            const goldPerSec = ((0.1 + cityCount * 0.05) * mult + inspectCountry.tradeDeals.length * 0.2) * 10;
            const troopsPerSec = 0.2 * mult * 10;
            return (
              <div className="space-y-2 text-sm text-gray-300">
                <div>Owner: <span className="text-white">{inspectCountry.owner ? (inspectCountry.owner === "player" ? "You" : gameState.bots.find(b => b.id === inspectCountry.owner)?.name || "Unknown") : "Unowned"}</span></div>
                {inspectCountry.owner && inspectCountry.owner !== "player" && gameState.alliances.includes(inspectCountry.owner) && (
                  <div className="text-cyan-400 font-bold">🕊 Allied with you</div>
                )}
                <div>Troops: <span className="text-white">{Math.floor(inspectCountry.troops)}</span> <span className="text-green-400">(+{troopsPerSec.toFixed(1)}/s)</span></div>
                <div>Gold: <span className="text-white">{Math.floor(inspectCountry.gold)}</span> <span className="text-yellow-400">(+{goldPerSec.toFixed(1)}/s)</span></div>
                <div>Buildings: <span className="text-white">{inspectCountry.buildings.length > 0 ? inspectCountry.buildings.map(b => b.icon).join(" ") : "None"}</span></div>
                <div>Relations: <span className="text-white">{inspectCountry.relations.player || 0}</span></div>
                <div>Trade Deals: <span className="text-white">{inspectCountry.tradeDeals.length}</span></div>
                {(() => {
                  const ownerId = inspectCountry.owner;
                  const lvls = ownerId === "player"
                    ? gameState.researchLevels
                    : (ownerId ? gameState.botResearch?.[ownerId] : null);
                  if (!lvls) return null;
                  return (
                    <div className="pt-1 border-t border-[#4a5568]">
                      <div className="text-[11px] text-cyan-400 font-bold mb-1">🔬 Research Levels</div>
                      <div className="grid grid-cols-2 gap-x-2 text-[11px]">
                        <div>Atk: <span className="text-white">Lv {lvls.atk || 0}/5</span></div>
                        <div>Def: <span className="text-white">Lv {lvls.def || 0}/5</span></div>
                        <div>Gold: <span className="text-white">Lv {lvls.gold || 0}/5</span></div>
                        <div>Troop: <span className="text-white">Lv {lvls.troop || 0}/5</span></div>
                      </div>
                    </div>
                  );
                })()}
              </div>
            );
          })()}
        </div>
      )}

      {/* Attack setup modal */}
      {attackTarget && !battle && (() => {
        const target = gameState.countries[attackTarget];
        if (!target) return null;
        const fortCount = target.buildings.filter((b) => b.type === "fort").length;
        const defenseMult = 1 + fortCount * 0.02;
        const courthouseCount = target.buildings.filter((b) => b.type === "courthouse").length;

        // Naval rule: if target does NOT border any player-owned country,
        // the player can only send up to (port count) * 1000 troops, AND
        // the target must itself be coastal (no overseas inland invasions).
        const playerOwnedIds = new Set(
          Object.values(gameState.countries).filter(c => c.owner === "player").map(c => c.id)
        );
        const nbMap = neighborsRef.current;
        const targetNeighbors = nbMap[attackTarget] || new Set<string>();
        const borders = Array.from(targetNeighbors).some(n => playerOwnedIds.has(n));
        const playerPorts = Object.values(gameState.countries)
          .filter(c => c.owner === "player")
          .reduce((s, c) => s + c.buildings.filter(b => b.type === "port").length, 0);
        const navalCap = playerPorts * 1000;
        const targetIsCoastal = target.isCoastal !== false;
        const navalBlocked = !borders && !targetIsCoastal;
        const maxAtkRaw = Math.floor(gameState.troops);
        const maxAtk = borders ? maxAtkRaw : Math.min(maxAtkRaw, navalCap);

        const maxTanks = Math.floor(gameState.tanks);
        const maxPlanes = Math.floor(gameState.planes);

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setAttackTarget(null)}>
            <div className="bg-[#0f1420] border border-[#4a5568] rounded-xl p-5 w-[420px] max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
              <div className="flex justify-between items-center mb-3">
                <h3 className="text-white font-bold">⚔ Attack {target.name}</h3>
                <button onClick={() => setAttackTarget(null)} className="text-gray-400 hover:text-white">✕</button>
              </div>
              <div className="text-sm text-gray-300 space-y-2">
                <div>Defender troops: <span className="text-red-400 font-bold">{Math.floor(target.troops)}</span> | Planes: <span className="text-cyan-400">{Math.floor(target.planes)}</span></div>
                <div>Forts: <span className="text-white">{fortCount}</span> <span className="text-gray-400">(+{(fortCount * 2)}% defense)</span></div>
                {courthouseCount > 0 && <div>Courthouses: <span className="text-white">{courthouseCount}</span> <span className="text-gray-400">(+{courthouseCount * 20}% defense)</span></div>}
                {!borders && (
                  <div className={`p-2 rounded text-xs ${navalBlocked ? "bg-red-900/40 text-red-300" : "bg-blue-900/30 text-blue-200"}`}>
                    {navalBlocked
                      ? `🚫 No land border and target is landlocked — cannot reach!`
                      : `⚓ Naval invasion: ${playerPorts} port(s) → max ${navalCap} troops`}
                  </div>
                )}
                <div>Your troops: <span className="text-green-400 font-bold">{maxAtkRaw}</span> | Tanks: <span className="text-yellow-400">{maxTanks}</span> | Planes: <span className="text-cyan-400">{maxPlanes}</span></div>
                <div className="pt-2">
                  <label className="text-xs text-gray-400">Send troops: <span className="text-white font-bold">{attackTroops}</span> / {maxAtk}</label>
                  <input
                    type="range"
                    min={1}
                    max={Math.max(1, maxAtk)}
                    value={Math.min(attackTroops, maxAtk)}
                    onChange={(e) => setAttackTroops(parseInt(e.target.value))}
                    className="w-full"
                    disabled={navalBlocked || maxAtk < 1}
                  />
                </div>
                <div className="pt-1">
                  <label className="text-xs text-gray-400">Send tanks: <span className="text-yellow-300 font-bold">{Math.min(attackTanks, maxTanks)}</span> / {maxTanks} <span className="text-gray-500">(1 tank = 10 troop strength)</span></label>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, maxTanks)}
                    value={Math.min(attackTanks, maxTanks)}
                    onChange={(e) => setAttackTanks(parseInt(e.target.value))}
                    className="w-full"
                    disabled={navalBlocked || maxTanks < 1}
                  />
                </div>
                <div className="pt-1">
                  <label className="text-xs text-gray-400">Send planes: <span className="text-cyan-300 font-bold">{Math.min(attackPlanes, maxPlanes)}</span> / {maxPlanes}</label>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, maxPlanes)}
                    value={Math.min(attackPlanes, maxPlanes)}
                    onChange={(e) => setAttackPlanes(parseInt(e.target.value))}
                    className="w-full"
                    disabled={navalBlocked || maxPlanes < 1}
                  />
                </div>
              </div>
              <div className="flex gap-2 mt-4">
                <button
                  onClick={() => setAttackTarget(null)}
                  className="flex-1 px-3 py-2 rounded bg-[#1a2030] text-gray-300 text-sm hover:bg-[#252d40]"
                >Cancel</button>
                <button
                  onClick={() => {
                    if (navalBlocked) return;
                    const sendTroops = Math.min(attackTroops, maxAtk);
                    const sendTanks = Math.min(attackTanks, maxTanks);
                    const sendPlanes = Math.min(attackPlanes, maxPlanes);
                    if (sendTroops < 1) return;
                    setGameState((prev) => prev ? {
                      ...prev,
                      troops: prev.troops - sendTroops,
                      tanks: prev.tanks - sendTanks,
                      planes: prev.planes - sendPlanes,
                    } : prev);
                    setBattle({
                      targetId: attackTarget,
                      attacker: sendTroops,
                      defender: Math.floor(target.troops),
                      attackerTanks: sendTanks,
                      attackerPlanes: sendPlanes,
                      defenderPlanes: Math.floor(target.planes),
                      progress: 0,
                      defenseMult,
                      initialDefender: Math.floor(target.troops),
                    });
                    if (target.owner && target.owner.startsWith("human-")) {
                      mpBroadcast({
                        type: "attack_started",
                        from: myOwnerKeyRef.current,
                        fromName: myNameRef.current,
                        targetCountryId: attackTarget,
                        troops: sendTroops,
                      });
                    }
                    setAttackTarget(null);
                  }}
                  disabled={navalBlocked || attackTroops < 1 || maxAtk < 1}
                  className="flex-1 px-3 py-2 rounded bg-red-600 hover:bg-red-700 text-white text-sm font-bold disabled:opacity-50"
                >⚔ Launch attack</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Battle progress modal */}
      {battle && (() => {
        const target = gameState.countries[battle.targetId];
        if (!target) return null;
        const total = battle.attacker + battle.defender || 1;
        const atkPct = (battle.attacker / total) * 100;
        return (
          <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 bg-[#0f1420]/95 border border-red-500/50 rounded-xl p-4 w-[420px] shadow-2xl">
            <div className="text-white font-bold text-sm mb-2 text-center">⚔ Battle for {target.name}</div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-green-400">You: {Math.floor(battle.attacker)} 👥 + {Math.floor(battle.attackerTanks)} 🚜</span>
              <span className="text-red-400">{target.name}: {Math.floor(battle.defender)} 👥</span>
            </div>
            <div className="w-full h-3 bg-red-900/60 rounded overflow-hidden mb-2">
              <div className="h-full bg-green-500 transition-all" style={{ width: `${atkPct}%` }} />
            </div>
            {/* Air superiority bar */}
            <div className="flex justify-between text-[10px] mb-1">
              <span className="text-cyan-400">✈ You: {Math.floor(battle.attackerPlanes)}</span>
              <span className="text-orange-400">✈ Enemy: {Math.floor(battle.defenderPlanes)}</span>
            </div>
            <div className="w-full h-2 bg-orange-900/60 rounded overflow-hidden mb-2 flex">
              {(() => {
                const totalPlanes = battle.attackerPlanes + battle.defenderPlanes || 1;
                const atkAirPct = (battle.attackerPlanes / totalPlanes) * 100;
                return <div className="h-full bg-cyan-500 transition-all" style={{ width: `${atkAirPct}%` }} />;
              })()}
            </div>
            <div className="text-[10px] text-center mb-1">
              {battle.attackerPlanes > battle.defenderPlanes ? (
                <span className="text-cyan-400 font-bold">✈ AIR SUPERIORITY (you) +50% atk</span>
              ) : battle.defenderPlanes > battle.attackerPlanes ? (
                <span className="text-orange-400 font-bold">✈ AIR SUPERIORITY (enemy) +50% def</span>
              ) : (
                <span className="text-gray-500">Air contested</span>
              )}
            </div>
            <div className="text-[10px] text-gray-400 mb-1">Battle progress</div>
            <div className="w-full h-2 bg-[#1a2030] rounded overflow-hidden">
              <div className="h-full bg-[#f97316] transition-all" style={{ width: `${battle.progress}%` }} />
            </div>
            <div className="text-[10px] text-gray-500 mt-2 text-center">
              Defender effectiveness: ×{battle.defenseMult.toFixed(2)}
              {battle.forceAttackUntil && Date.now() < battle.forceAttackUntil && (
                <span className="text-orange-400 ml-2">🔥 FORCE ATTACK ({Math.ceil((battle.forceAttackUntil - Date.now()) / 1000)}s)</span>
              )}
              {battle.lastStandUntil && Date.now() < battle.lastStandUntil && (
                <span className="text-blue-400 ml-2">🛡 LAST STAND ({Math.ceil((battle.lastStandUntil - Date.now()) / 1000)}s)</span>
              )}
              {battle.aiLastStandUntil && Date.now() < battle.aiLastStandUntil && (
                <span className="text-red-400 ml-2">🛡 ENEMY LAST STAND ({Math.ceil((battle.aiLastStandUntil - Date.now()) / 1000)}s)</span>
              )}
            </div>
            <div className="flex gap-2 mt-3">
              <button
                onClick={() => {
                  // Cancel: return surviving troops, tanks, planes
                  setGameState((prev) => prev ? {
                    ...prev,
                    troops: prev.troops + battle.attacker,
                    tanks: prev.tanks + battle.attackerTanks,
                    planes: prev.planes + battle.attackerPlanes,
                  } : prev);
                  setBattle(null);
                  showNotif("🏳 Attack cancelled — surviving forces returned.");
                }}
                className="flex-1 px-2 py-1.5 rounded bg-gray-600 hover:bg-gray-700 text-white text-xs font-bold"
              >🏳 Retreat</button>
              <div className="flex gap-2 mt-3">
              <button
                onClick={() => {
                  if (!gameState || gameState.politicalPower < 50) { showNotif("Need 50 PP!"); return; }
                  if (battle.forceAttackUntil && Date.now() < battle.forceAttackUntil) { showNotif("Already active!"); return; }
                  setGameState((prev) => prev ? { ...prev, politicalPower: prev.politicalPower - 50 } : prev);
                  setBattle((b) => b ? { ...b, forceAttackUntil: Date.now() + 15000 } : b);
                  showNotif("🔥 Force Attack activated! +50% power, +20% losses for 15s");
                }}
                disabled={!gameState || gameState.politicalPower < 50 || (!!battle.forceAttackUntil && Date.now() < battle.forceAttackUntil)}
                className="flex-1 px-2 py-1.5 rounded bg-orange-600 hover:bg-orange-700 text-white text-xs font-bold disabled:opacity-50"
              >🔥 Force (50PP)</button>
              
              <button
                onClick={() => {
                  if (!gameState || gameState.politicalPower < 50) { showNotif("Need 50 PP!"); return; }
                  if (battle.lastStandUntil && Date.now() < battle.lastStandUntil) { showNotif("Already active!"); return; }
                  setGameState((prev) => prev ? { ...prev, politicalPower: prev.politicalPower - 50 } : prev);
                  setBattle((b) => b ? { ...b, lastStandUntil: Date.now() + 20000 } : b);
                  showNotif("🛡 Last Stand activated! +100% defense for 20s");
                }}
                disabled={!gameState || gameState.politicalPower < 50 || (!!battle.lastStandUntil && Date.now() < battle.lastStandUntil)}
                className="flex-1 px-2 py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold disabled:opacity-50"
              >🛡 Last Stand (50PP)</button>
            </div>
          </div>
        );
      })()}

      {/* Defender battle modal — live read-only view when another human attacks one of our countries */}
      {defenderBattle && (() => {
        const db = defenderBattle;
        const target = gameState.countries[db.targetId];
        if (!target || target.owner !== "player") return null;
        // Auto-clear if no updates in 8s (attacker disconnected/finished without sending battle_ended)
        const stale = Date.now() - db.updatedAt > 8000;
        if (stale) { setTimeout(() => setDefenderBattle(null), 0); return null; }
        const total = db.attacker + db.defender || 1;
        const atkPct = (db.attacker / total) * 100;
        const totalPlanes = db.attackerPlanes + db.defenderPlanes || 1;
        const atkAirPct = (db.attackerPlanes / totalPlanes) * 100;
        const lastStandActive = !!(db.lastStandUntil && Date.now() < db.lastStandUntil);
        const forceActive = !!(db.forceAttackUntil && Date.now() < db.forceAttackUntil);
        return (
          <div className="fixed top-20 right-4 z-50 bg-[#0f1420]/95 border border-red-500/50 rounded-xl p-4 w-[380px] shadow-2xl">
            <div className="text-white font-bold text-sm mb-2 text-center">
              🛡 DEFENDING {target.name}
            </div>
            <div className="text-[11px] text-red-300 text-center mb-2">
              ⚠ {db.attackerName} is attacking!
            </div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-red-400">Enemy: {Math.floor(db.attacker)} 👥 + {Math.floor(db.attackerTanks)} 🚜</span>
              <span className="text-green-400">You: {Math.floor(db.defender)} 👥</span>
            </div>
            <div className="w-full h-3 bg-green-900/60 rounded overflow-hidden mb-2">
              <div className="h-full bg-red-500 transition-all" style={{ width: `${atkPct}%` }} />
            </div>
            <div className="flex justify-between text-[10px] mb-1">
              <span className="text-orange-400">✈ Enemy: {Math.floor(db.attackerPlanes)}</span>
              <span className="text-cyan-400">✈ You: {Math.floor(db.defenderPlanes)}</span>
            </div>
            <div className="w-full h-2 bg-cyan-900/60 rounded overflow-hidden mb-2">
              <div className="h-full bg-orange-500 transition-all" style={{ width: `${atkAirPct}%` }} />
            </div>
            <div className="text-[10px] text-gray-400 mb-1">Battle progress</div>
            <div className="w-full h-2 bg-[#1a2030] rounded overflow-hidden">
              <div className="h-full bg-[#f97316] transition-all" style={{ width: `${db.progress}%` }} />
            </div>
            <div className="text-[10px] text-gray-500 mt-2 text-center">
              {forceActive && <span className="text-orange-400">🔥 ENEMY FORCE ATTACK ({Math.ceil((db.forceAttackUntil! - Date.now()) / 1000)}s) </span>}
              {lastStandActive && <span className="text-blue-400">🛡 LAST STAND ({Math.ceil((db.lastStandUntil! - Date.now()) / 1000)}s)</span>}
            </div>
            <div className="flex gap-2 mt-3">
              <button
                onClick={() => {
                  if (!gameState || gameState.politicalPower < 50) { showNotif("Need 50 PP!"); return; }
                  if (lastStandActive) { showNotif("Already active!"); return; }
                  const until = Date.now() + 20000;
                  setGameState((prev) => prev ? { ...prev, politicalPower: prev.politicalPower - 50 } : prev);
                  setDefenderBattle((d) => d ? { ...d, lastStandUntil: until } : d);
                  mpBroadcast({
                    type: "defender_last_stand",
                    from: myOwnerKeyRef.current,
                    targetCountryId: db.targetId,
                    until,
                  });
                  showNotif("🛡 Last Stand! +100% defense for 20s");
                }}
                disabled={!gameState || gameState.politicalPower < 50 || lastStandActive}
                className="flex-1 px-2 py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold disabled:opacity-50"
              >🛡 Last Stand (50PP)</button>
            </div>
          </div>
        );
      })()}

      {/* Notification */}
      {notification && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-40 bg-[#0f1420]/95 backdrop-blur-sm border border-[#f97316] text-white px-4 py-2 rounded-lg text-sm animate-fade-in">
          {notification}
        </div>
      )}

      {/* Exit button */}
      <div className="absolute top-3 right-3 z-20">
        <button onClick={onExit} className="px-3 py-1.5 rounded bg-[#0f1420]/80 text-gray-400 hover:text-white border border-[#4a5568] text-xs">
          ✕ Exit
        </button>
      </div>
    </div>
  );
}
