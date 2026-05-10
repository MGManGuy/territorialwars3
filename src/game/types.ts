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
  factory:    { icon: "🏭", label: "Factory",    cost: 150, description: "+1 tank/sec (1 tank = 10 troop strength)" },
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
  formedNations?: string[]; // formable ids player has formed
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
// Colors inspired by each country's flag/national identity (flag-color palette)
export const COUNTRY_COLORS: Record<string, string> = {
  // Major Powers
  "840": "#3c5a99", // USA - deep blue
  "124": "#cc0000", // Canada - red
  "156": "#de2910", // China - red
  "643": "#2d5a2d", // Russia - dark green
  "250": "#0044cc", // France - blue
  "826": "#c8102e", // UK - red
  "276": "#333333", // Germany - dark
  "356": "#e67e22", // India - saffron
  "076": "#009b3a", // Brazil - green
  "392": "#bc002d", // Japan - crimson
  // Europe
  "724": "#c60b1e", // Spain
  "380": "#009246", // Italy - green
  "528": "#ae1c28", // Netherlands
  "616": "#dc143c", // Poland
  "752": "#006aa7", // Sweden - blue
  "578": "#ef2b2d", // Norway
  "246": "#003580", // Finland
  "208": "#c60c30", // Denmark
  "040": "#ed2939", // Austria
  "756": "#ff0000", // Switzerland
  "056": "#000000", // Belgium
  "620": "#006600", // Portugal
  "300": "#0d5eaf", // Greece
  "348": "#436f4d", // Hungary
  "642": "#002B7F", // Romania
  "203": "#d7141a", // Czech Republic
  "703": "#0b4ea2", // Slovakia
  "191": "#171796", // Croatia
  "070": "#002395", // Bosnia
  "688": "#c6363c", // Serbia
  "499": "#d4af37", // Montenegro
  "807": "#006747", // North Macedonia
  "008": "#e41e20", // Albania
  "705": "#003DA5", // Slovenia
  "440": "#fdb913", // Lithuania
  "428": "#9e3039", // Latvia
  "233": "#0072ce", // Estonia
  "112": "#cf101a", // Belarus
  "804": "#005bbb", // Ukraine
  "498": "#003DA5", // Moldova
  "100": "#00966e", // Bulgaria
  "372": "#169b62", // Ireland
  // Asia
  "792": "#e30a17", // Turkey
  "682": "#006c35", // Saudi Arabia
  "818": "#c09a3a", // Egypt
  "368": "#007a3d", // Iraq
  "364": "#239f40", // Iran
  "760": "#007a3d", // Syria
  "422": "#00a550", // Lebanon
  "400": "#007a3d", // Jordan
  "784": "#00732f", // UAE
  "634": "#8d1b3d", // Qatar
  "414": "#007a3d", // Kuwait
  "512": "#db161b", // Oman
  "887": "#009a44", // Yemen
  "586": "#01411c", // Pakistan
  "050": "#006a4e", // Bangladesh
  "524": "#003893", // Nepal
  "064": "#ff8000", // Bhutan
  "144": "#8d153a", // Sri Lanka
  "704": "#da251d", // Vietnam
  "116": "#032ea1", // Cambodia
  "764": "#a51931", // Thailand
  "418": "#ce1126", // Laos
  "104": "#fecb00", // Myanmar
  "458": "#cc0001", // Malaysia
  "608": "#0038a8", // Philippines
  "360": "#ce1126", // Indonesia
  "096": "#f7e017", // Brunei
  "410": "#003478", // South Korea
  "408": "#024fa2", // North Korea
  "496": "#c4272f", // Mongolia
  "398": "#009b77", // Kazakhstan
  "860": "#1eb53a", // Uzbekistan
  "762": "#006600", // Tajikistan
  "795": "#30a000", // Turkmenistan
  "417": "#e8112d", // Kyrgyzstan
  "004": "#000000", // Afghanistan
  "031": "#0092bc", // Azerbaijan
  "051": "#003580", // Armenia
  "268": "#d50000", // Georgia
  "356": "#e67e22", // India (dup safety)
  // Africa
  "566": "#008751", // Nigeria
  "012": "#006233", // Algeria
  "710": "#007a4d", // South Africa
  "404": "#006600", // Kenya
  "231": "#078930", // Ethiopia
  "504": "#c1272d", // Morocco
  "788": "#e70013", // Tunisia
  "434": "#000000", // Libya
  "729": "#d21034", // Sudan
  "800": "#fcdc04", // Uganda
  "834": "#1eb53a", // Tanzania
  "516": "#003580", // Namibia
  "716": "#006400", // Zimbabwe
  "508": "#009a44", // Mozambique
  "072": "#75aadb", // Botswana
  "894": "#198a00", // Zambia
  "454": "#000000", // Malawi
  "108": "#ce1126", // Burundi
  "646": "#20603d", // Rwanda
  "180": "#007fff", // DRC
  "178": "#009a00", // Republic of Congo
  "120": "#007a5e", // Cameroon
  "140": "#289728", // Central African Republic
  "148": "#002664", // Chad
  "562": "#e05206", // Niger
  "466": "#14b53a", // Mali
  "854": "#ef2b2d", // Burkina Faso
  "686": "#00853f", // Senegal
  "288": "#006b3f", // Ghana
  "324": "#ce1126", // Guinea
  "384": "#f77f00", // Ivory Coast
  "430": "#003221", // Liberia
  "694": "#1eb53a", // Sierra Leone
  "204": "#008751", // Benin
  "768": "#006a4e", // Togo
  "566": "#008751", // Nigeria (dup safety)
  "266": "#009e60", // Gabon
  "450": "#fc3d32", // Madagascar
  "748": "#3e5eb9", // Eswatini
  "426": "#009543", // Lesotho
  "262": "#6ab2e7", // Djibouti
  "232": "#4189dd", // Eritrea
  "706": "#4189dd", // Somalia
  "478": "#006233", // Mauritania
  "624": "#ce1126", // Guinea-Bissau
  "270": "#3a7728", // Gambia
  "132": "#003893", // Cape Verde
  "678": "#12ad2b", // São Tomé
  "174": "#3a75c4", // Comoros
  "174": "#3a75c4", // Comoros
  // Americas
  "032": "#74acdf", // Argentina
  "152": "#d52b1e", // Chile
  "170": "#fcd116", // Colombia
  "604": "#d91023", // Peru
  "862": "#cf142b", // Venezuela
  "218": "#ffd100", // Ecuador
  "068": "#d52b1e", // Bolivia
  "600": "#d52b1e", // Paraguay
  "858": "#ffffff", // Uruguay - light blue would be invisible, use mid blue
  "328": "#009e60", // Guyana
  "740": "#377e3f", // Suriname
  "484": "#006847", // Mexico
  "320": "#4997d0", // Guatemala
  "340": "#0073cf", // Honduras
  "558": "#3e6d96", // Nicaragua
  "188": "#002b7f", // Costa Rica
  "591": "#005293", // Panama
  "192": "#002a8f", // Cuba
  "214": "#002d62", // Dominican Republic
  "332": "#00209f", // Haiti
  "388": "#000000", // Jamaica - dark gold
  "780": "#ce1126", // Trinidad
  // Oceania
  "036": "#00008b", // Australia
  "554": "#00247d", // New Zealand
  "598": "#000000", // Papua New Guinea
  "242": "#003087", // Fiji
  "090": "#003087", // Solomon Islands
  "548": "#009543", // Vanuatu
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
