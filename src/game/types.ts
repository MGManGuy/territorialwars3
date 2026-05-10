// HOI4-style world conquest game types

export interface Country {
  id: string; // ISO numeric code
  name: string;
  owner: string | null; // player id or bot id, null = unowned
  troops: number;
  tanks: number;
  planes: number;
  gold: number;
  buildings: Building[];
  relations: Record<string, number>; // owner id -> relation score
  tradeDeals: string[]; // owner ids with active trade deals
  color: string | null; // fill color when owned
  isCoastal?: boolean;
  diplomatUntil?: number; // timestamp when diplomat mission ends
}

export interface Building {
  type: BuildingType;
  icon: string;
  x?: number; // SVG x coordinate where placed
  y?: number; // SVG y coordinate where placed
}

export type BuildingType = "city" | "factory" | "port" | "fort" | "barracks" | "courthouse" | "airbase";

export const BUILDING_DEFS: Record<BuildingType, { icon: string; label: string; cost: number; description: string; requiresCoast?: boolean }> = {
  city:       { icon: "🏙", label: "City",       cost: 100, description: "+5 gold/sec" },
  factory:    { icon: "🏭", label: "Factory",    cost: 150, description: "+10 troops/sec, +1 tank/sec" },
  port:       { icon: "⚓", label: "Port",       cost: 120, description: "Allows 1000 troops to attack non-bordering countries (coastal)", requiresCoast: true },
  fort:       { icon: "🛡", label: "Fort",       cost: 80,  description: "+2% defense per fort" },
  barracks:   { icon: "🪖", label: "Barracks",   cost: 130, description: "+8 troops/sec" },
  courthouse: { icon: "⚖", label: "Courthouse", cost: 140, description: "+0.5 PP/sec" },
  airbase:    { icon: "✈", label: "Air Base",    cost: 200, description: "Costs 2 gold/sec, produces 1 plane/sec" },
};

export const BUILDING_SLOTS: BuildingType[] = ["city", "factory", "port", "fort", "barracks", "courthouse", "airbase"];

export interface War {
  countryId: string;
  startedAt: number; // Date.now() timestamp
  lastBotAttack?: number; // timestamp of last bot counter-attack
}

export interface Research {
  id: string;
  label: string;
  cost: number;
  durationMs: number;
  description: string;
}

export const RESEARCH_DEFS: Research[] = [
  { id: "atk",   label: "Improved Tactics",   cost: 1000, durationMs: 60000, description: "+10% attack power" },
  { id: "def",   label: "Defensive Doctrine", cost: 1000, durationMs: 60000, description: "+10% defense" },
  { id: "gold",  label: "Trade Networks",     cost: 1000, durationMs: 60000, description: "+10% gold income" },
  { id: "troop", label: "Conscription",       cost: 1000, durationMs: 60000, description: "+10% troop production" },
];

export interface Goal {
  id: string;
  label: string;
  description: string;
  reward: number; // PP reward
}

export const GOALS: Goal[] = [
  { id: "continent", label: "Conquer Your Continent", description: "Own every country on your starting continent", reward: 200 },
  { id: "ten",       label: "Empire of Ten",          description: "Own 10 countries",                              reward: 500 },
  { id: "twentyfive",label: "Quarter Century",        description: "Own 25 countries",                              reward: 1000 },
];

export interface ActiveResearch {
  id: string;
  startedAt: number;
}

export const MAX_RESEARCH_LEVEL = 5;

export interface NotificationEntry {
  id: number;
  message: string;
  timestamp: number;
}

export interface GameState {
  countries: Record<string, Country>;
  playerId: string;
  playerCountryId: string;
  bots: BotState[];
  date: GameDate;
  speed: number; // 1,2,3,5
  paused: boolean;
  gold: number;
  troops: number;
  tanks: number;
  planes: number;
  politicalPower: number;
  alliances: string[]; // owner ids allied with the player
  warGoals: string[]; // country ids the player has justified war goals on
  wars: War[]; // active wars with metadata
  guarantees: string[]; // country ids the player guarantees independence of
  researchLevels: Record<string, number>; // research id -> level (0..MAX_RESEARCH_LEVEL)
  activeResearch: ActiveResearch | null;
  completedGoals: string[];
  notifications: NotificationEntry[];
  // Bot research progress: botId -> researchId -> level
  botResearch: Record<string, Record<string, number>>;
  // Bot saved gold earmarked for research
  botSavings: Record<string, number>;
}

export interface BotState {
  id: string;
  name: string;
  color: string;
  countryIds: string[];
}

export interface GameDate {
  day: number;
  month: number;
  year: number;
}

export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

export const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function advanceDate(d: GameDate, days: number): GameDate {
  let { day, month, year } = { ...d };
  for (let i = 0; i < days; i++) {
    day++;
    if (day > DAYS_IN_MONTH[month]) {
      day = 1;
      month++;
      if (month > 11) { month = 0; year++; }
    }
  }
  return { day, month, year };
}

export function formatDate(d: GameDate): string {
  return `${d.day} ${MONTHS[d.month]} ${d.year}`;
}

export const BOT_COLORS = [
  "#e63946", "#457b9d", "#2a9d8f", "#e9c46a", "#f4a261",
  "#264653", "#6a4c93", "#1982c4", "#8ac926", "#ff595e",
  "#ffca3a", "#6a0572", "#ab83a1", "#c1666b", "#48639c",
  "#d4a373", "#606c38", "#283618", "#bc6c25", "#dda15e",
  "#003049", "#d62828", "#f77f00", "#fcbf49", "#eae2b7",
  "#0077b6", "#00b4d8", "#90e0ef", "#023e8a", "#780000",
];

export const PLAYER_COLOR = "#7c3aed"; // purple

// Custom country colors override BOT_COLORS for these nations
export const COUNTRY_COLORS: Record<string, string> = {
  "840": "#4a7fb5", // USA
  "124": "#c41e3a", // Canada
  "156": "#de2910", // China
  "643": "#4d7a4d", // Russia
  "250": "#002395", // France
  "826": "#012169", // UK
  "276": "#5a5a5a", // Germany
  "724": "#c60b1e", // Spain
  "818": "#c09a3a", // Egypt
  "682": "#1a6b3a", // Saudi Arabia
  "356": "#f77f00", // India - Saffron Orange
  "586": "#1a7a3a", // Pakistan - Forest Green
  "076": "#009c3b", // Brazil
  "392": "#bc002d", // Japan
  "792": "#c8102e", // Turkey
  "380": "#009246", // Italy
  "528": "#ae1c28", // Netherlands
  "616": "#dc143c", // Poland
  "710": "#007a4d", // South Africa
  "484": "#006847", // Mexico
  "360": "#ce1126", // Indonesia
  "704": "#da251d", // Vietnam
  "764": "#a51931", // Thailand
  "050": "#006a4e", // Bangladesh
  "410": "#003478", // South Korea
  "566": "#008751", // Nigeria
  "012": "#006233", // Algeria
  "032": "#74acdf", // Argentina
  "152": "#d52b1e", // Chile
  "170": "#fcd116", // Colombia
  "400": "#007a3d", // Jordan
};

// Continent assignments by ISO numeric code (for goal tracking)
export const CONTINENTS: Record<string, string> = {
  // North America
  "840": "NA", "124": "NA", "484": "NA", "320": "NA", "340": "NA", "188": "NA", "558": "NA", "591": "NA", "222": "NA", "192": "NA", "214": "NA", "332": "NA", "388": "NA",
  // South America
  "076": "SA", "032": "SA", "152": "SA", "604": "SA", "170": "SA", "862": "SA", "218": "SA", "068": "SA", "600": "SA", "858": "SA", "328": "SA", "740": "SA",
  // Europe
  "250": "EU", "276": "EU", "826": "EU", "380": "EU", "724": "EU", "620": "EU", "528": "EU", "056": "EU", "040": "EU", "756": "EU", "752": "EU", "578": "EU", "246": "EU", "208": "EU", "372": "EU", "300": "EU", "616": "EU", "348": "EU", "642": "EU", "203": "EU", "703": "EU", "688": "EU", "191": "EU", "070": "EU", "807": "EU", "008": "EU", "499": "EU", "100": "EU", "705": "EU", "440": "EU", "428": "EU", "233": "EU", "498": "EU", "804": "EU", "112": "EU", "643": "EU",
  // Asia
  "156": "AS", "356": "AS", "392": "AS", "410": "AS", "408": "AS", "704": "AS", "764": "AS", "458": "AS", "360": "AS", "608": "AS", "586": "AS", "050": "AS", "364": "AS", "368": "AS", "682": "AS", "792": "AS", "004": "AS", "398": "AS", "860": "AS", "417": "AS", "762": "AS", "795": "AS", "496": "AS", "104": "AS", "116": "AS", "418": "AS", "031": "AS", "051": "AS", "268": "AS", "400": "AS", "422": "AS", "760": "AS", "414": "AS", "634": "AS", "784": "AS", "512": "AS", "887": "AS", "144": "AS", "524": "AS", "064": "AS", "096": "AS",
  // Africa
  "818": "AF", "566": "AF", "012": "AF", "504": "AF", "434": "AF", "729": "AF", "732": "AF", "478": "AF", "466": "AF", "562": "AF", "148": "AF", "024": "AF", "180": "AF", "178": "AF", "120": "AF", "140": "AF", "231": "AF", "706": "AF", "404": "AF", "834": "AF", "508": "AF", "710": "AF", "716": "AF", "894": "AF", "454": "AF", "072": "AF", "516": "AF", "266": "AF", "288": "AF", "384": "AF", "324": "AF", "430": "AF", "694": "AF", "270": "AF", "686": "AF", "204": "AF", "768": "AF", "854": "AF", "450": "AF", "646": "AF", "108": "AF", "800": "AF", "728": "AF", "262": "AF", "232": "AF", "748": "AF", "426": "AF", "624": "AF",
  // Oceania
  "036": "OC", "554": "OC", "598": "OC", "242": "OC", "548": "OC", "090": "OC",
};

export const CONTINENT_NAMES: Record<string, string> = {
  NA: "North America", SA: "South America", EU: "Europe", AS: "Asia", AF: "Africa", OC: "Oceania",
};

// ===== Formable nations =====
export interface Formable {
  id: string;
  name: string;
  flag: string;
  color: string;
  ppCost: number;
  requiredCountryIds: string[];
}

export const FORMABLES: Formable[] = [
  { id: "soviet",    name: "Soviet Union",            flag: "☭", color: "#cc0000", ppCost: 250,
    requiredCountryIds: ["643","804","112","398","860","762","795","417","051","031","268","428","440","233"] },
  { id: "caliphate", name: "Middle Eastern Caliphate", flag: "☪", color: "#1a6b3a", ppCost: 250,
    requiredCountryIds: ["682","368","760","400","818","887","784","512","414","634","048","364"] },
  { id: "eu",        name: "European Union",           flag: "★", color: "#003399", ppCost: 300,
    requiredCountryIds: ["276","250","380","724","620","528","056","040","752","246","208","372","300","100","203","616","642","440","428","233","703","705","191"] },
  { id: "rome",      name: "Roman Empire",             flag: "🦅", color: "#8b1a1a", ppCost: 300,
    requiredCountryIds: ["380","250","724","620","300","818","504","788","760","422","792","008","807","642"] },
  { id: "mongol",    name: "Mongol Empire",            flag: "🐎", color: "#5c4033", ppCost: 250,
    requiredCountryIds: ["496","156","643","398","417","860","762","795","804"] },
  { id: "india",     name: "Greater India",            flag: "🕉", color: "#f77f00", ppCost: 200,
    requiredCountryIds: ["356","586","050","144","524","064","104"] },
];

export interface FormedNation {
  formableId: string;
  formedAt: number;
}

