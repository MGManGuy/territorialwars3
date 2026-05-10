import type { Country, GameState, BotState, GameDate } from "./types";
import { BOT_COLORS, BUILDING_DEFS, PLAYER_COLOR, COUNTRY_COLORS } from "./types";
import { getCountryName } from "./countryNames";

// Tier multipliers for starting resources (matches econ multipliers in GameMap)
const MAJOR_POWERS = new Set(["840", "156", "356", "076", "643"]); // USA, China, India, Brazil, Russia
const SECONDARY_POWERS = new Set(["250", "826", "586", "682", "124", "276"]); // FR, UK, PK, SA, CA, DE

function startingResources(countryId: string, isPlayer: boolean) {
  let goldBase = 200;
  let troopBase = 300;
  let ppBase = 25;
  if (MAJOR_POWERS.has(countryId)) {
    goldBase = 800;
    troopBase = 1500;
    ppBase = 75;
  } else if (SECONDARY_POWERS.has(countryId)) {
    goldBase = 450;
    troopBase = 800;
    ppBase = 50;
  }
  // Player gets a small extra cushion regardless of country picked
  if (isPlayer) {
    goldBase += 100;
    troopBase += 200;
  }
  return { gold: goldBase, troops: troopBase, politicalPower: ppBase };
}

// Tiny seeded PRNG so multiple clients in the same lobby generate the same world.
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function initGameState(
  playerCountryId: string,
  allCountryIds: string[],
  botCount: number = 30,
  opts?: { seed?: string; reservedOwners?: Record<string, { id: string; name: string; color: string }> }
): GameState {
  const rand = opts?.seed ? mulberry32(hashSeed(opts.seed)) : Math.random;
  // Always-assigned powers (so Russia/USA/China/etc. never end up as unowned grey blobs)
  const PRIORITY_POWERS = [
    "840", "156", "356", "076", "643", // majors: USA, China, India, Brazil, Russia
    "250", "826", "586", "682", "124", "276", // secondaries: FR, UK, PK, SA, CA, DE
  ];

  // Assign EVERY country (not just BOT_COUNTRY_POOL) so no nation is unowned.
  const reserved = opts?.reservedOwners || {};
  const reservedIds = new Set(Object.keys(reserved));
  const allAvailable = allCountryIds.filter(
    (id) => id !== playerCountryId && !reservedIds.has(id) && !["010"].includes(id)
  );
  const priority = PRIORITY_POWERS.filter((id) => allAvailable.includes(id));
  const rest = allAvailable.filter((id) => !priority.includes(id));
  const shuffledRest = [...rest].sort(() => rand() - 0.5);
  const botAssignments = [...priority, ...shuffledRest];
  void botCount;

  const bots: BotState[] = botAssignments.map((countryId, i) => ({
    id: `bot-${i}`,
    name: getCountryName(countryId),
    color: COUNTRY_COLORS[countryId] || BOT_COLORS[i % BOT_COLORS.length],
    countryIds: [countryId],
  }));

  const countries: Record<string, Country> = {};
  const unownedPalette = [
    "#5a6b5a", "#6b5a5a", "#5a5a6b", "#6b6b5a", "#5a6b6b",
    "#7a8a7a", "#8a7a7a", "#7a7a8a", "#8a8a7a", "#7a8a8a",
    "#4d5d4d", "#5d4d4d", "#4d4d5d", "#5d5d4d", "#4d5d5d",
    "#6f7f6f", "#7f6f6f", "#6f6f7f", "#7f7f6f", "#6f7f7f",
  ];
  let paletteIdx = 0;
  for (const cid of allCountryIds) {
    const botOwner = bots.find((b) => b.countryIds.includes(cid));
    const humanOwner = reserved[cid];
    const isPlayer = cid === playerCountryId;
    const unownedColor = unownedPalette[paletteIdx++ % unownedPalette.length];
    const start = startingResources(cid, isPlayer);
    // Custom country colors override bot color
    const customColor = COUNTRY_COLORS[cid];
    const ownedColor = isPlayer
      ? PLAYER_COLOR
      : humanOwner
        ? (customColor || humanOwner.color)
        : botOwner
          ? (customColor || botOwner.color)
          : unownedColor;
    countries[cid] = {
      id: cid,
      name: getCountryName(cid),
      owner: isPlayer ? "player" : humanOwner ? humanOwner.id : botOwner ? botOwner.id : null,
      troops: start.troops,
      tanks: 0,
      planes: 0,
      gold: start.gold,
      buildings: [],
      relations: {},
      tradeDeals: [],
      color: ownedColor,
    };
  }

  const date: GameDate = { day: 1, month: 0, year: 2025 };

  // Player aggregate starting pool reflects their country tier
  const playerStart = startingResources(playerCountryId, true);

  return {
    countries,
    playerId: "player",
    playerCountryId,
    bots,
    date,
    speed: 1,
    paused: false,
    gold: playerStart.gold,
    troops: playerStart.troops,
    tanks: 0,
    planes: 0,
    politicalPower: playerStart.politicalPower,
    alliances: [],
    warGoals: [],
    wars: [],
    guarantees: [],
    researchLevels: { atk: 0, def: 0, gold: 0, troop: 0 },
    activeResearch: null,
    completedGoals: [],
    notifications: [],
    botResearch: Object.fromEntries(bots.map(b => [b.id, { atk: 0, def: 0, gold: 0, troop: 0 }])),
    botSavings: Object.fromEntries(bots.map(b => [b.id, 0])),
  };
}

// Per-country econ multipliers (mirror of GameMap COUNTRY_ECON_MULT).
const ECON_MULT: Record<string, number> = {
  "840": 8.0, "156": 8.0, "356": 6.5, "076": 5.5, "643": 6.5,
  "250": 3.0, "826": 3.0, "586": 2.5, "682": 3.0, "124": 3.0, "276": 3.2,
};

// Mirror of GameMap variance — small deterministic per-country jitter so
// every non-major country earns at a slightly different rate.
function variance(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return 0.7 + ((h % 1000) / 1000) * 0.55;
}
function effectiveMult(id: string): number {
  if (ECON_MULT[id] != null) {
    const j = 0.95 + ((Array.from(id).reduce((a, c) => a + c.charCodeAt(0), 0) % 100) / 1000);
    return ECON_MULT[id] * j;
  }
  return variance(id);
}

export function getGoldRate(state: GameState): number {
  let rate = 0;
  const playerCountries = Object.values(state.countries).filter(c => c.owner === "player");
  for (const c of playerCountries) {
    const mult = effectiveMult(c.id);
    // Base 1 gold/sec per country, scaled by country tier
    rate += 1 * mult;
    rate += c.buildings.filter(b => b.type === "city").length * 5;
    rate += c.tradeDeals.length * 2;
  }
  return Math.round(rate * 10) / 10;
}

export function getTroopRate(state: GameState): number {
  let rate = 0;
  const playerCountries = Object.values(state.countries).filter(c => c.owner === "player");
  for (const c of playerCountries) {
    const mult = effectiveMult(c.id);
    // Base 2 troops/sec per country, scaled by country tier
    rate += 2 * mult;
    rate += c.buildings.filter(b => b.type === "factory").length * 10;
    rate += c.buildings.filter(b => b.type === "barracks").length * 2;
  }
  return Math.round(rate * 10) / 10;
}

export function getPoliticalPowerRate(state: GameState): number {
  // 1 PP per second base, +0.5 per owned country, +5 per courthouse
  const owned = Object.values(state.countries).filter(c => c.owner === "player");
  const courthouseCount = owned.reduce(
    (sum, c) => sum + c.buildings.filter(b => b.type === "courthouse").length, 0
  );
  return 1 + owned.length * 0.5 + courthouseCount * 0.5;
}

export function getLeaderboard(state: GameState) {
  const ownerStats: Record<string, { name: string; color: string; countries: number; gold: number; troops: number }> = {};

  ownerStats["player"] = { name: "You", color: PLAYER_COLOR, countries: 0, gold: 0, troops: 0 };
  for (const bot of state.bots) {
    ownerStats[bot.id] = { name: bot.name, color: bot.color, countries: 0, gold: 0, troops: 0 };
  }

  // Aggregate gold/troops from each country owned by each entity
  for (const c of Object.values(state.countries)) {
    if (c.owner && ownerStats[c.owner]) {
      ownerStats[c.owner].countries++;
      ownerStats[c.owner].gold += c.gold;
      ownerStats[c.owner].troops += c.troops;
    }
  }

  // For the player, the authoritative gold/troops live on the GameState itself
  // (the bottom-left HUD shows state.gold / state.troops). Mirror those here so
  // the leaderboard matches what the player actually sees.
  if (ownerStats["player"]) {
    ownerStats["player"].gold = state.gold;
    ownerStats["player"].troops = state.troops;
  }

  return Object.entries(ownerStats)
    .filter(([, v]) => v.countries > 0)
    .sort((a, b) => {
      // Sort by combined power (troops weighted more than gold)
      const powerA = a[1].troops + a[1].gold * 0.5;
      const powerB = b[1].troops + b[1].gold * 0.5;
      return powerB - powerA;
    })
    .map(([id, v], i) => ({ id, rank: i + 1, ...v }));
}

// Mid-size countries suitable for bot assignment
const BOT_COUNTRY_POOL = [
  "032", "036", "040", "050", "056", "068", "076", "100", "104", "112",
  "116", "120", "124", "148", "152", "156", "170", "191", "192", "203",
  "208", "218", "231", "246", "250", "268", "276", "288", "300", "348",
  "356", "360", "364", "368", "380", "392", "398", "404", "410", "434",
  "458", "484", "496", "504", "508", "516", "524", "528", "554", "558",
  "566", "578", "586", "604", "608", "616", "620", "642", "643", "682",
  "686", "688", "704", "710", "724", "752", "756", "764", "788", "792",
  "804", "818", "826", "834", "840", "854", "858", "862",
];
