import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";

type Difficulty = "easy" | "normal" | "hard";

interface Props {
  onSinglePlayer: (difficulty: Difficulty) => void;
  onMultiplayer: (playerName: string) => void;
  onJoinPublic: (playerName: string, lobbyId: string) => void;
}

const SYSTEM_HOST = "00000000-0000-0000-0000-000000000000";

function minuteBucket(d: Date = new Date()): string {
  // Stable per-minute code, e.g. "P-202605041423"
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `P-${yyyy}${mm}${dd}${hh}${mi}`.slice(0, 16);
}

const MAPS = [
  { id: "world", label: "World" },
  { id: "giant", label: "Giant World Map" },
  { id: "europe", label: "Europe" },
  { id: "europe_classic", label: "Europe Classic" },
  { id: "north_america", label: "North America" },
  { id: "south_america", label: "South America" },
  { id: "oceania", label: "Oceania" },
  { id: "africa", label: "Africa" },
  { id: "asia", label: "Asia" },
];

export default function MainMenu({ onSinglePlayer, onMultiplayer, onJoinPublic }: Props) {
  const navigate = useNavigate();
  const [showInstructions, setShowInstructions] = useState(false);
  const [showLobby, setShowLobby] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showTos, setShowTos] = useState(false);
  const [name, setName] = useState(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem("tw:playerName") || "";
  });
  const [playerColor, setPlayerColor] = useState(() => {
    if (typeof window === "undefined") return "#7c3aed";
    return localStorage.getItem("tw:playerColor") || "#7c3aed";
  });
  const [showColorPicker, setShowColorPicker] = useState(false);
  const colorButtonRef = useRef<HTMLButtonElement>(null);
  const [colorPickerPos, setColorPickerPos] = useState<{ top: number; left: number } | null>(null);

  // Persist name + color so the user only enters them once.
  useEffect(() => {
    if (name) localStorage.setItem("tw:playerName", name);
  }, [name]);
  useEffect(() => {
    localStorage.setItem("tw:playerColor", playerColor);
  }, [playerColor]);

  // Position the color picker via fixed coords (parent uses backdrop-blur
  // which creates a stacking context and traps absolute z-index).
  useEffect(() => {
    if (!showColorPicker || !colorButtonRef.current) return;
    const r = colorButtonRef.current.getBoundingClientRect();
    setColorPickerPos({ top: r.bottom + 8, left: r.left });
  }, [showColorPicker]);

  const [language, setLanguage] = useState<"en" | "fr">("en");
  const [showLangMenu, setShowLangMenu] = useState(false);
  const [selectedMap, setSelectedMap] = useState("world");
  const [difficulty, setDifficulty] = useState<Difficulty>("easy");
  const [mode, setMode] = useState<"ffa" | "teams">("ffa");
  const [economy, setEconomy] = useState<"classic" | "fast">("classic");
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [sfx, setSfx] = useState(true);
  const [music, setMusic] = useState(true);
  const [nextLobbyIn, setNextLobbyIn] = useState(60);
  

  const COLOR_PALETTE = [
    "#f97316", "#ef4444", "#eab308", "#10b981",
    "#14b8a6", "#3b82f6", "#7c3aed", "#ec4899",
    "#ffffff", "#1f2937",
  ];

  const LANGS = [
    { id: "en" as const, flag: "🇬🇧", label: "English" },
    { id: "fr" as const, flag: "🇫🇷", label: "Français" },
  ];
  const currentLang = LANGS.find(l => l.id === language)!;

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUserEmail(data.session?.user?.email ?? null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      setUserEmail(session?.user?.email ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    setUserEmail(null);
  };

  // Public-lobby countdown: every minute, the next public game opens.
  useEffect(() => {
    const tick = () => {
      const secs = 60 - (Math.floor(Date.now() / 1000) % 60);
      setNextLobbyIn(secs);
    };
    tick();
    const i = setInterval(tick, 1000);
    return () => clearInterval(i);
  }, []);

  // The single open public lobby for the current minute (auto-rotated).
  const [currentPublic, setCurrentPublic] = useState<{ id: string; code: string; player_count: number } | null>(null);
  const [minuteTick, setMinuteTick] = useState(0);

  // Bump minuteTick when nextLobbyIn rolls over to 60.
  useEffect(() => {
    if (nextLobbyIn === 60) setMinuteTick(t => t + 1);
  }, [nextLobbyIn]);

  // Ensure a public auto-lobby exists for the current minute, then load it.
  useEffect(() => {
    let cancelled = false;
    const ensureAndLoad = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      const code = minuteBucket();

      if (session?.user) {
        await supabase
          .from("lobbies")
          .insert({
            code,
            host_id: SYSTEM_HOST,
            name: `Public ${code.slice(2, 10)}-${code.slice(10)}`,
            map: "world",
            difficulty: "normal",
            mode: "ffa",
            economy: "fast",
            max_players: 30,
            status: "waiting",
            is_public: true,
            is_system: true,
          })
          .select()
          .maybeSingle();
        // Duplicate-key conflicts are expected and fine — another client made it.
      }

      const { data: lobby } = await supabase
        .from("lobbies")
        .select("id, code")
        .eq("code", code)
        .maybeSingle();

      if (cancelled || !lobby) return;

      const { count } = await supabase
        .from("lobby_players")
        .select("*", { count: "exact", head: true })
        .eq("lobby_id", lobby.id);

      if (cancelled) return;
      setCurrentPublic({ id: lobby.id, code: lobby.code, player_count: count ?? 0 });
    };
    ensureAndLoad();
    return () => { cancelled = true; };
  }, [minuteTick]);

  // Live player count for the current open public lobby.
  useEffect(() => {
    if (!currentPublic) return;
    const lobbyId = currentPublic.id;
    const ch = supabase
      .channel(`pub-${lobbyId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "lobby_players", filter: `lobby_id=eq.${lobbyId}` },
        async () => {
          const { count } = await supabase
            .from("lobby_players")
            .select("*", { count: "exact", head: true })
            .eq("lobby_id", lobbyId);
          setCurrentPublic(p => p && p.id === lobbyId ? { ...p, player_count: count ?? 0 } : p);
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [currentPublic?.id]);

  const handleJoinNext = async () => {
    if (!name.trim()) return;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) {
      navigate({ to: "/auth" });
      return;
    }
    if (!currentPublic) return;
    onJoinPublic(name.trim(), currentPublic.id);
  };


  return (
    <div
      className="relative w-full h-full bg-cover bg-center"
      style={{
        backgroundImage:
          "linear-gradient(rgba(10,15,25,0.55), rgba(10,15,25,0.75)), url('https://upload.wikimedia.org/wikipedia/commons/thumb/8/83/Equirectangular_projection_SW.jpg/1280px-Equirectangular_projection_SW.jpg')",
      }}
    >
      {/* Top-left buttons */}
      <div className="absolute top-4 left-4 flex gap-3 z-10 items-center">
        {userEmail ? (
          <>
            <div className="h-12 px-3 rounded-lg bg-[#0f1420]/80 border border-[#4a5568] text-white flex items-center text-sm shadow-lg">
              👤 {userEmail}
            </div>
            <button
              onClick={handleSignOut}
              className="h-12 px-3 rounded-lg bg-[#1a2030] border border-[#4a5568] text-gray-200 hover:text-white text-sm shadow-lg transition"
              title="Sign out"
            >
              Sign out
            </button>
          </>
        ) : (
          <button
            onClick={() => navigate({ to: "/auth" })}
            className="h-12 px-4 rounded-lg bg-[#f97316] hover:bg-[#ea580c] text-white flex items-center gap-2 font-bold shadow-lg transition"
            title="Sign in"
          >
            👤 Sign in
          </button>
        )}
      </div>

      {/* Top-right language */}
      <div className="absolute top-4 right-4 z-10">
        <button
          onClick={() => setShowLangMenu(v => !v)}
          className="px-4 h-12 rounded-lg bg-[#f97316] hover:bg-[#ea580c] text-white font-bold flex items-center gap-2 shadow-lg transition"
        >
          {currentLang.flag} {currentLang.label}
        </button>
        {showLangMenu && (
          <div className="absolute right-0 mt-2 w-44 bg-[#0f1420] border border-[#4a5568] rounded-lg shadow-2xl overflow-hidden">
            {LANGS.map(l => (
              <button
                key={l.id}
                onClick={() => { setLanguage(l.id); setShowLangMenu(false); }}
                className={`w-full px-4 py-2 text-left flex items-center gap-2 hover:bg-white/10 transition ${language === l.id ? "text-[#f97316] font-bold" : "text-white"}`}
              >
                <span className="text-lg">{l.flag}</span> {l.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Center content */}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 px-4">
        {/* Title */}
        <h1
          className="text-7xl md:text-8xl font-extrabold text-[#f97316] tracking-tight drop-shadow-[0_4px_12px_rgba(0,0,0,0.6)]"
          style={{ WebkitTextStroke: "2px white", paintOrder: "stroke fill" }}
        >
          Territorial Wars
        </h1>

        {/* Name + color bar */}
        <div className="flex items-center gap-3 bg-[#0f1420]/80 backdrop-blur-md border border-[#4a5568] rounded-xl p-3 w-full max-w-2xl shadow-xl relative">
          <div className="relative">
            <button
              ref={colorButtonRef}
              onClick={() => setShowColorPicker(v => !v)}
              className="w-12 h-12 rounded-md flex items-center justify-center border-2 border-white/20 hover:border-white/60 transition"
              style={{ backgroundColor: playerColor }}
              title="Pick your country color"
            />
            {showColorPicker && colorPickerPos && typeof document !== "undefined" && createPortal(
              <>
                <div
                  className="fixed inset-0 z-[9998]"
                  onClick={() => setShowColorPicker(false)}
                />
                <div
                  className="fixed z-[9999] bg-[#0f1420] border border-[#4a5568] rounded-lg p-3 shadow-2xl grid grid-cols-5 gap-2 w-56"
                  style={{ top: colorPickerPos.top, left: colorPickerPos.left }}
                >
                  {COLOR_PALETTE.map(c => (
                    <button
                      key={c}
                      onClick={() => { setPlayerColor(c); setShowColorPicker(false); }}
                      className={`w-8 h-8 rounded-md border-2 transition ${playerColor === c ? "border-white scale-110" : "border-transparent hover:border-white/50"}`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                  <label className="col-span-5 mt-2 flex items-center gap-2 text-xs text-gray-300">
                    Custom
                    <input
                      type="color"
                      value={playerColor}
                      onChange={(e) => setPlayerColor(e.target.value)}
                      className="w-8 h-8 rounded cursor-pointer bg-transparent border-0"
                    />
                  </label>
                </div>
              </>,
              document.body
            )}
          </div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Insert name here"
            className="flex-1 bg-transparent text-white px-3 py-2 outline-none placeholder-gray-400"
          />
          <span className="text-[10px] font-bold text-[#f97316] bg-[#f97316]/10 border border-[#f97316] rounded px-2 py-0.5">NEW</span>
        </div>

        {/* Two-column area */}
        <div className="flex flex-col md:flex-row gap-4 w-full max-w-2xl">
          {/* Left: Join next game card */}
          <div className="flex-1 bg-[#0f1420]/80 backdrop-blur-md border border-[#4a5568] rounded-xl p-4 shadow-xl flex flex-col">
            <div className="text-center text-white font-bold mb-2">Join next Game</div>
            <div className="flex flex-wrap gap-2 justify-center mb-3">
              <span className="text-[10px] font-bold text-gray-300 bg-white/10 rounded px-2 py-0.5">FAST</span>
              <span className="text-[10px] font-bold text-gray-300 bg-white/10 rounded px-2 py-0.5">FREE FOR ALL</span>
              <span className="text-[10px] font-bold text-gray-300">World</span>
            </div>
            <div className="flex-1 rounded bg-gradient-to-br from-[#1a2030] to-[#0a0f1a] flex flex-col items-center justify-center text-center p-3 gap-2">
              <div className="text-4xl">🌍</div>
              <div className="text-xs text-gray-400">Next public lobby in</div>
              <div className="text-3xl font-extrabold text-[#f97316] font-mono tabular-nums">
                {String(Math.floor(nextLobbyIn / 60)).padStart(2, "0")}:{String(nextLobbyIn % 60).padStart(2, "0")}
              </div>
              <button
                onClick={handleJoinNext}
                disabled={!name.trim()}
                className="mt-1 px-4 py-2 rounded-lg bg-[#f97316] hover:bg-[#ea580c] text-white text-xs font-bold disabled:opacity-50 disabled:cursor-not-allowed transition"
                title={!name.trim() ? "Enter a name first" : "Join the next public lobby"}
              >
                Join Now
              </button>
            </div>
            <div className="flex justify-between text-xs text-gray-400 mt-2">
              <span>👥 {currentPublic?.player_count ?? 0}/30 in lobby</span>
              <span className="bg-[#f97316] text-white rounded px-2 py-0.5 font-bold">LIVE</span>
            </div>
          </div>

          {/* Right: buttons */}
          <div className="flex-1 flex flex-col gap-3">
            <button
              onClick={() => setShowLobby(true)}
              className="w-full py-4 rounded-xl bg-[#f97316] hover:bg-[#ea580c] text-white font-bold text-lg shadow-lg transition"
            >
              Single Player
            </button>
            <button
              disabled={!name.trim()}
              onClick={() => onMultiplayer(name.trim())}
              className="w-full py-4 rounded-xl bg-[#1a2030]/80 border border-[#4a5568] text-gray-200 hover:text-white hover:bg-[#1a2030] font-bold text-lg shadow-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
              title={!name.trim() ? "Enter a name first" : "Create or join a multiplayer lobby"}
            >
              Multiplayer
            </button>
            <button
              onClick={() => setShowInstructions(true)}
              className="w-full py-4 rounded-xl bg-[#1a2030]/80 border border-[#4a5568] text-gray-300 hover:text-white hover:bg-[#1a2030] font-bold text-lg shadow-lg transition"
            >
              Instructions
            </button>
          </div>
        </div>
      </div>

      {/* Bottom links */}
      <div className="absolute bottom-4 left-0 right-0 flex justify-center gap-8 text-sm text-gray-400 z-10">
        <span className="hover:text-white cursor-pointer" onClick={() => setShowAbout(true)}>About</span>
        <span className="hover:text-white cursor-pointer" onClick={() => setShowPrivacy(true)}>Privacy Policy</span>
        <span className="hover:text-white cursor-pointer" onClick={() => setShowTos(true)}>Terms of Service</span>
      </div>

      {/* Settings */}
      <button
        onClick={() => setShowSettings(true)}
        className="absolute bottom-4 right-4 w-12 h-12 rounded-lg bg-[#f97316] hover:bg-[#ea580c] text-white flex items-center justify-center text-xl shadow-lg z-10 transition"
        title="Settings"
      >
        ⚙
      </button>

      {/* Settings modal */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={() => setShowSettings(false)}>
          <div
            className="bg-[#0f1420] border border-[#4a5568] rounded-xl p-6 max-w-md w-full text-gray-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-2xl font-bold text-white">Settings</h2>
              <button
                onClick={() => setShowSettings(false)}
                className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-gray-300 flex items-center justify-center"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4">
              <label className="flex items-center justify-between p-3 rounded-lg bg-[#1a2030] border border-[#4a5568]">
                <span className="font-medium">Sound effects</span>
                <input type="checkbox" checked={sfx} onChange={(e) => setSfx(e.target.checked)} className="w-5 h-5 accent-[#f97316]" />
              </label>
              <label className="flex items-center justify-between p-3 rounded-lg bg-[#1a2030] border border-[#4a5568]">
                <span className="font-medium">Music</span>
                <input type="checkbox" checked={music} onChange={(e) => setMusic(e.target.checked)} className="w-5 h-5 accent-[#f97316]" />
              </label>

              <div className="p-3 rounded-lg bg-[#1a2030] border border-[#4a5568]">
                <div className="text-xs text-gray-400 mb-1">Account</div>
                {userEmail ? (
                  <div className="flex items-center justify-between">
                    <span className="text-sm">{userEmail}</span>
                    <button
                      onClick={handleSignOut}
                      className="px-3 py-1 rounded bg-[#f97316] hover:bg-[#ea580c] text-white text-sm font-bold"
                    >
                      Sign out
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => { setShowSettings(false); navigate({ to: "/auth" }); }}
                    className="w-full px-3 py-2 rounded bg-[#f97316] hover:bg-[#ea580c] text-white text-sm font-bold"
                  >
                    Sign in / Sign up
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── SINGLE PLAYER LOBBY MODAL ── */}
      {showLobby && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
          <div className="bg-[#0f1420] border border-[#4a5568] rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between p-5 border-b border-[#4a5568]">
              <h2 className="text-2xl font-bold text-white">Single Player</h2>
              <button
                onClick={() => setShowLobby(false)}
                className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-gray-300 flex items-center justify-center transition text-lg"
              >
                ✕
              </button>
            </div>

            <div className="p-5 space-y-6">
              {/* MAP */}
              <div>
                <div className="text-center mb-3">
                  <div className="text-white font-bold text-sm tracking-widest">MAP</div>
                  <div className="text-gray-400 text-xs">Continental</div>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {MAPS.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => setSelectedMap(m.id)}
                      className={`rounded-lg p-2 border-2 transition flex flex-col items-center gap-1 ${
                        selectedMap === m.id
                          ? "border-[#f97316] bg-[#f97316]/10"
                          : "border-[#4a5568] bg-[#1a2030] hover:border-[#6a7588]"
                      }`}
                    >
                      <div className="w-full h-14 rounded bg-[#0a0f1a] flex items-center justify-center text-2xl">
                        🌍
                      </div>
                      <span className="text-xs text-gray-300 text-center leading-tight">{m.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* DIFFICULTY */}
              <div>
                <div className="text-center mb-3 text-white font-bold text-sm tracking-widest">DIFFICULTY</div>
                <div className="grid grid-cols-3 gap-2">
                  {([
                    { id: "easy" as Difficulty, label: "Easy", desc: "Weak AI economy" },
                    { id: "normal" as Difficulty, label: "Normal", desc: "AI +25% income" },
                    { id: "hard" as Difficulty, label: "Hard", desc: "AI +60% income" },
                  ]).map((d) => (
                    <button
                      key={d.id}
                      onClick={() => setDifficulty(d.id)}
                      className={`rounded-lg p-3 border-2 transition text-center ${
                        difficulty === d.id
                          ? "border-[#f97316] bg-[#f97316]/10"
                          : "border-[#4a5568] bg-[#1a2030] hover:border-[#6a7588]"
                      }`}
                    >
                      <div className={`font-bold text-sm mb-1 ${difficulty === d.id ? "text-[#f97316]" : "text-gray-200"}`}>
                        {d.label}
                      </div>
                      <div className="text-xs text-gray-400">{d.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* MODE */}
              <div>
                <div className="text-center mb-3 text-white font-bold text-sm tracking-widest">MODE</div>
                <div className="grid grid-cols-2 gap-2">
                  {(["ffa", "teams"] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setMode(m)}
                      className={`py-3 rounded-xl font-bold transition ${
                        mode === m
                          ? "bg-[#f97316] text-white"
                          : "bg-[#1a2030] border border-[#4a5568] text-gray-300 hover:text-white"
                      }`}
                    >
                      {m === "ffa" ? "Free for All" : "Teams"}
                    </button>
                  ))}
                </div>
              </div>

              {/* ECONOMY MODE */}
              <div>
                <div className="text-center mb-3 text-white font-bold text-sm tracking-widest">ECONOMY MODE</div>
                <div className="grid grid-cols-2 gap-2">
                  {(["classic", "fast"] as const).map((e) => (
                    <button
                      key={e}
                      onClick={() => setEconomy(e)}
                      className={`py-3 rounded-xl font-bold transition capitalize ${
                        economy === e
                          ? "bg-[#f97316] text-white"
                          : "bg-[#1a2030] border border-[#4a5568] text-gray-300 hover:text-white"
                      }`}
                    >
                      {e === "classic" ? "Classic" : "Fast"}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Start */}
            <div className="p-5 border-t border-[#4a5568]">
              <button
                onClick={() => { setShowLobby(false); onSinglePlayer(difficulty); }}
                className="w-full py-4 rounded-xl bg-[#f97316] hover:bg-[#ea580c] text-white font-bold text-lg shadow-lg transition"
              >
                Start Game
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Instructions modal */}
      {showInstructions && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={() => setShowInstructions(false)}>
          <div
            className="bg-[#0f1420] border border-[#4a5568] rounded-xl p-6 max-w-lg w-full text-gray-200 max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-2xl font-bold text-white mb-3">How to Play</h2>
            <ul className="text-sm space-y-2 list-disc pl-5">
              <li>Pick a country, then conquer the world.</li>
              <li>Right-click a country for actions (attack, build, diplomacy).</li>
              <li>Build factories for tanks, air bases for planes, ports for naval invasions.</li>
              <li>Research techs (up to lvl 5 each) for permanent +50% bonuses.</li>
              <li>Use Force Attack & Last Stand during battles for tactical edges.</li>
            </ul>
            <button
              onClick={() => setShowInstructions(false)}
              className="mt-4 px-4 py-2 rounded bg-[#f97316] hover:bg-[#ea580c] text-white font-bold"
            >
              Got it
            </button>
          </div>
        </div>
      )}

      {/* About modal */}
      {showAbout && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={() => setShowAbout(false)}>
          <div
            className="bg-[#0f1420] border border-[#4a5568] rounded-xl p-6 max-w-lg w-full text-gray-200 max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-2xl font-bold text-white">About FrontWars</h2>
              <button onClick={() => setShowAbout(false)} className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-gray-300 flex items-center justify-center">✕</button>
            </div>
            <div className="space-y-4 text-sm leading-relaxed">
              <p>
                <span className="text-[#f97316] font-bold">FrontWars</span> is a browser-based grand strategy game where you pick a nation and compete to dominate the world map — solo against AI or against other players in real-time multiplayer lobbies.
              </p>
              <p>
                Build factories, research technologies, forge alliances, and lead your armies across land, air, and sea to achieve total victory.
              </p>
              <div className="border-t border-[#4a5568] pt-4">
                <div className="text-xs text-gray-400">Version 1.0 · Made with ❤️ by the FrontWars Team</div>
              </div>
            </div>
            <button onClick={() => setShowAbout(false)} className="mt-5 px-4 py-2 rounded bg-[#f97316] hover:bg-[#ea580c] text-white font-bold">
              Close
            </button>
          </div>
        </div>
      )}

      {/* Privacy Policy modal */}
      {showPrivacy && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={() => setShowPrivacy(false)}>
          <div
            className="bg-[#0f1420] border border-[#4a5568] rounded-xl p-6 max-w-lg w-full text-gray-200 max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-2xl font-bold text-white">Privacy Policy</h2>
              <button onClick={() => setShowPrivacy(false)} className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-gray-300 flex items-center justify-center">✕</button>
            </div>
            <div className="space-y-4 text-sm leading-relaxed">
              <p className="text-xs text-gray-400">Last updated: May 2026</p>
              <div>
                <h3 className="text-white font-bold mb-1">Data We Collect</h3>
                <p>We collect your email address when you register, your chosen player name and color, and basic gameplay statistics (scores, win/loss records). We do not sell your personal data to third parties.</p>
              </div>
              <div>
                <h3 className="text-white font-bold mb-1">How We Use Your Data</h3>
                <p>Your data is used solely to provide the game service: authenticating your account, saving your preferences, and powering multiplayer matchmaking.</p>
              </div>
              <div>
                <h3 className="text-white font-bold mb-1">Cookies &amp; Storage</h3>
                <p>We use browser local storage to save your session and preferences. No third-party advertising cookies are used.</p>
              </div>
              <div>
                <h3 className="text-white font-bold mb-1">Data Retention</h3>
                <p>Account data is retained for as long as your account is active. You may request deletion at any time by contacting us.</p>
              </div>
              <div>
                <h3 className="text-white font-bold mb-1">Contact</h3>
                <p>For privacy-related requests, please reach out through our official community channels.</p>
              </div>
            </div>
            <button onClick={() => setShowPrivacy(false)} className="mt-5 px-4 py-2 rounded bg-[#f97316] hover:bg-[#ea580c] text-white font-bold">
              Close
            </button>
          </div>
        </div>
      )}

      {/* Terms of Service modal */}
      {showTos && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={() => setShowTos(false)}>
          <div
            className="bg-[#0f1420] border border-[#4a5568] rounded-xl p-6 max-w-lg w-full text-gray-200 max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-2xl font-bold text-white">Terms of Service</h2>
              <button onClick={() => setShowTos(false)} className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-gray-300 flex items-center justify-center">✕</button>
            </div>
            <div className="space-y-4 text-sm leading-relaxed">
              <p className="text-xs text-gray-400">Last updated: May 2026</p>
              <div>
                <h3 className="text-white font-bold mb-1">Acceptance of Terms</h3>
                <p>By accessing or playing FrontWars, you agree to be bound by these Terms of Service. If you do not agree, please discontinue use immediately.</p>
              </div>
              <div>
                <h3 className="text-white font-bold mb-1">Eligibility</h3>
                <p>You must be at least 13 years of age to use FrontWars. By registering an account, you confirm that you meet this requirement.</p>
              </div>
              <div>
                <h3 className="text-white font-bold mb-1">Conduct</h3>
                <p>You agree not to use cheats, exploits, automation software, bots, or any other unauthorized third-party software. Harassment, hate speech, or abusive behavior toward other players is prohibited and may result in account termination.</p>
              </div>
              <div>
                <h3 className="text-white font-bold mb-1">Intellectual Property</h3>
                <p>All game content, graphics, and code are the property of the FrontWars Team. You may not reproduce or redistribute any part of the game without written permission.</p>
              </div>
              <div>
                <h3 className="text-white font-bold mb-1">Disclaimer</h3>
                <p>FrontWars is provided "as is" without warranties of any kind. We reserve the right to modify or discontinue the service at any time.</p>
              </div>
              <div>
                <h3 className="text-white font-bold mb-1">Changes to Terms</h3>
                <p>We may update these terms at any time. Continued use of the game after changes constitutes acceptance of the new terms.</p>
              </div>
            </div>
            <button onClick={() => setShowTos(false)} className="mt-5 px-4 py-2 rounded bg-[#f97316] hover:bg-[#ea580c] text-white font-bold">
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
