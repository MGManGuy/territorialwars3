import { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";

interface Lobby {
  id: string;
  code: string;
  host_id: string;
  name: string;
  map: string;
  difficulty: string;
  mode: string;
  economy: string;
  max_players: number;
  status: string;
  is_public: boolean;
  created_at: string;
  started_at?: string | null;
}

interface LobbyPlayer {
  id: string;
  lobby_id: string;
  user_id: string;
  display_name: string;
  color: string;
  country_id: string | null;
  is_ready: boolean;
  is_host: boolean;
}

interface Props {
  playerName: string;
  autoJoinLobbyId?: string | null;
  onBack: () => void;
  onStartGame: (opts: { difficulty: "easy" | "normal" | "hard"; lobbyId: string; selectionEndsAt: string }) => void;
}

const COLORS = ["#f97316", "#3b82f6", "#10b981", "#ef4444", "#a855f7", "#eab308", "#14b8a6", "#ec4899"];

function genCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export default function MultiplayerLobby({ playerName, autoJoinLobbyId, onBack, onStartGame }: Props) {
  const navigate = useNavigate();
  const [userId, setUserId] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [view, setView] = useState<"browse" | "in-lobby">("browse");
  const [lobbies, setLobbies] = useState<Lobby[]>([]);
  const [currentLobby, setCurrentLobby] = useState<Lobby | null>(null);
  const [players, setPlayers] = useState<LobbyPlayer[]>([]);
  const [joinCode, setJoinCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [playersLoaded, setPlayersLoaded] = useState(false);
  const lobbyChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const startHandledRef = useRef<string | null>(null);

  // Require a real signed-in user. If none, send to /auth.
  useEffect(() => {
    let mounted = true;

    // Listen first so we don't miss state changes during getSession.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      if (session?.user) {
        setUserId(session.user.id);
        setAuthReady(true);
      } else {
        setUserId(null);
        navigate({ to: "/auth" });
      }
    });

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!mounted) return;
      if (session?.user) {
        setUserId(session.user.id);
        setAuthReady(true);
      } else {
        navigate({ to: "/auth" });
      }
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, [navigate]);

  // Browse lobbies (refresh + realtime)
  const refreshLobbies = useCallback(async () => {
    const { data } = await supabase
      .from("lobbies")
      .select("*")
      .eq("status", "waiting")
      .eq("is_public", true)
      .order("created_at", { ascending: false })
      .limit(30);
    setLobbies((data as Lobby[]) || []);
  }, []);

  useEffect(() => {
    if (!authReady || view !== "browse") return;
    refreshLobbies();
    const ch = supabase
      .channel("lobby-list")
      .on("postgres_changes", { event: "*", schema: "public", table: "lobbies" }, () => refreshLobbies())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [authReady, view, refreshLobbies]);

  // Auto-join a specific lobby (e.g., the public minute-rotated one).
  useEffect(() => {
    if (!authReady || !userId || !autoJoinLobbyId) return;
    let cancelled = false;
    (async () => {
      const { data: lobby } = await supabase
        .from("lobbies").select("*").eq("id", autoJoinLobbyId).maybeSingle();
      if (cancelled || !lobby) return;
      const { data: existing } = await supabase
        .from("lobby_players").select("id").eq("lobby_id", lobby.id).eq("user_id", userId).maybeSingle();
      if (!existing) {
        const { data: existingPlayers } = await supabase
          .from("lobby_players").select("color").eq("lobby_id", lobby.id);
        const used = new Set((existingPlayers || []).map((p: any) => p.color));
        const color = COLORS.find(c => !used.has(c)) || COLORS[0];
        await supabase.from("lobby_players").insert({
          lobby_id: lobby.id, user_id: userId,
          display_name: playerName || "Player", color, is_host: false,
        });
      }
      if (cancelled) return;
      setCurrentLobby(lobby as Lobby);
      setView("in-lobby");
    })();
    return () => { cancelled = true; };
  }, [authReady, userId, autoJoinLobbyId, playerName]);

  // In-lobby realtime
  useEffect(() => {
    if (!currentLobby) return;
    const lobbyId = currentLobby.id;
    setPlayersLoaded(false);

    const beginSelection = (lobby: Lobby) => {
      if (startHandledRef.current === lobby.id) return;
      startHandledRef.current = lobby.id;
      const startedAt = lobby.started_at ? new Date(lobby.started_at).getTime() : Date.now();
      onStartGame({
        difficulty: lobby.difficulty as any,
        lobbyId: lobby.id,
        selectionEndsAt: new Date(startedAt + 40_000).toISOString(),
      });
    };

    const fetchPlayers = async () => {
      const { data } = await supabase.from("lobby_players").select("*").eq("lobby_id", lobbyId).order("joined_at");
      setPlayers((data as LobbyPlayer[]) || []);
      setPlayersLoaded(true);
    };
    const fetchLobby = async () => {
      const { data } = await supabase.from("lobbies").select("*").eq("id", lobbyId).maybeSingle();
      if (data) {
        const lobby = data as Lobby;
        setCurrentLobby(lobby);
        if (lobby.status === "playing") beginSelection(lobby);
      } else {
        // lobby gone
        setCurrentLobby(null);
        setView("browse");
      }
    };
    fetchPlayers();

    const ch = supabase
      .channel(`lobby-${lobbyId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "lobby_players", filter: `lobby_id=eq.${lobbyId}` }, fetchPlayers)
      .on("postgres_changes", { event: "*", schema: "public", table: "lobbies", filter: `id=eq.${lobbyId}` }, fetchLobby)
      .on("broadcast", { event: "game-start" }, ({ payload }) => {
        beginSelection({ ...currentLobby, ...payload, status: "playing" } as Lobby);
      })
      .subscribe();
    lobbyChannelRef.current = ch;

    fetchLobby();

    return () => {
      if (lobbyChannelRef.current === ch) lobbyChannelRef.current = null;
      supabase.removeChannel(ch);
    };
  }, [currentLobby?.id, onStartGame]);

  // Auto-start public/system lobbies 60s after they were created.
  const [autoStartIn, setAutoStartIn] = useState<number | null>(null);
  useEffect(() => {
    if (!currentLobby || !currentLobby.created_at) { setAutoStartIn(null); return; }
    const isSystem = (currentLobby as any).is_system;
    if (!isSystem) { setAutoStartIn(null); return; }
    const startAt = new Date(currentLobby.created_at).getTime() + 60_000;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((startAt - Date.now()) / 1000));
      setAutoStartIn(remaining);
      if (remaining <= 0) {
        if (startHandledRef.current === currentLobby.id) return;
        startHandledRef.current = currentLobby.id;
        onStartGame({
          difficulty: currentLobby.difficulty as any,
          lobbyId: currentLobby.id,
          selectionEndsAt: new Date(startAt + 40_000).toISOString(),
        });
      }
    };
    tick();
    const i = setInterval(tick, 500);
    return () => clearInterval(i);
  }, [currentLobby, onStartGame]);

  // If our own player row was removed (kicked), bounce to browse.
  useEffect(() => {
    if (!playersLoaded || !currentLobby || !userId) return;
    const stillIn = players.some(p => p.user_id === userId);
    if (!stillIn) {
      setError("You were removed from the lobby.");
      setCurrentLobby(null);
      setPlayers([]);
      setView("browse");
    }
  }, [players, playersLoaded, currentLobby, userId]);

  const createLobby = async () => {
    if (!userId) return;
    setBusy(true); setError(null);
    const code = genCode();
    const { data: lobby, error: e1 } = await supabase
      .from("lobbies")
      .insert({
        code, host_id: userId,
        name: `${playerName || "Player"}'s Lobby`,
        map: "world", difficulty: "normal", mode: "ffa", economy: "classic",
        max_players: 8, status: "waiting", is_public: true,
      })
      .select().single();
    if (e1 || !lobby) {
      setError("Failed to create lobby" + (e1 ? `: ${e1.message}` : ""));
      setBusy(false);
      return;
    }
    const { error: e2 } = await supabase.from("lobby_players").insert({
      lobby_id: lobby.id, user_id: userId,
      display_name: playerName || "Host", color: COLORS[0], is_host: true,
    });
    if (e2) { setError("Failed to join own lobby: " + e2.message); setBusy(false); return; }
    setCurrentLobby(lobby as Lobby);
    setView("in-lobby");
    setBusy(false);
  };

  const joinLobby = async (lobby: Lobby) => {
    if (!userId) return;
    setBusy(true); setError(null);
    // already in?
    const { data: existing } = await supabase
      .from("lobby_players").select("*").eq("lobby_id", lobby.id).eq("user_id", userId).maybeSingle();
    if (!existing) {
      const { count } = await supabase
        .from("lobby_players").select("*", { count: "exact", head: true }).eq("lobby_id", lobby.id);
      if ((count ?? 0) >= lobby.max_players) { setError("Lobby full"); setBusy(false); return; }
      const usedColors = new Set<string>();
      const { data: existingPlayers } = await supabase.from("lobby_players").select("color").eq("lobby_id", lobby.id);
      (existingPlayers || []).forEach((p: any) => usedColors.add(p.color));
      const color = COLORS.find(c => !usedColors.has(c)) || COLORS[0];
      const { error } = await supabase.from("lobby_players").insert({
        lobby_id: lobby.id, user_id: userId,
        display_name: playerName || "Player", color, is_host: false,
      });
      if (error) { setError("Failed to join: " + error.message); setBusy(false); return; }
    }
    setCurrentLobby(lobby);
    setView("in-lobby");
    setBusy(false);
  };

  const joinByCode = async () => {
    if (!joinCode.trim()) return;
    setBusy(true); setError(null);
    const { data } = await supabase.from("lobbies")
      .select("*").eq("code", joinCode.trim().toUpperCase()).eq("status", "waiting").maybeSingle();
    if (!data) { setError("Lobby not found"); setBusy(false); return; }
    setBusy(false);
    await joinLobby(data as Lobby);
  };

  const leaveLobby = async () => {
    if (!currentLobby || !userId) return;
    const isHost = currentLobby.host_id === userId;
    if (isHost) {
      await supabase.from("lobbies").delete().eq("id", currentLobby.id);
    } else {
      await supabase.from("lobby_players").delete().eq("lobby_id", currentLobby.id).eq("user_id", userId);
    }
    setCurrentLobby(null);
    setPlayers([]);
    setView("browse");
  };

  const updateLobbySetting = async (patch: Partial<Lobby>) => {
    if (!currentLobby || currentLobby.host_id !== userId) return;
    // Optimistic update so the UI reflects immediately even if realtime is laggy.
    setCurrentLobby(prev => prev ? { ...prev, ...patch } as Lobby : prev);
    await supabase.from("lobbies").update(patch).eq("id", currentLobby.id);
  };

  const startGame = async () => {
    if (!currentLobby || currentLobby.host_id !== userId) return;
    const startedAt = new Date().toISOString();
    await supabase.from("lobbies").update({ status: "playing", started_at: startedAt }).eq("id", currentLobby.id);
    await lobbyChannelRef.current?.send({
      type: "broadcast",
      event: "game-start",
      payload: { id: currentLobby.id, difficulty: currentLobby.difficulty, started_at: startedAt },
    });
    if (startHandledRef.current !== currentLobby.id) {
      startHandledRef.current = currentLobby.id;
      onStartGame({
        difficulty: currentLobby.difficulty as any,
        lobbyId: currentLobby.id,
        selectionEndsAt: new Date(new Date(startedAt).getTime() + 40_000).toISOString(),
      });
    }
  };

  const kickPlayer = async (playerUserId: string) => {
    if (!currentLobby || currentLobby.host_id !== userId) return;
    if (playerUserId === userId) return;
    await supabase.from("lobby_players").delete()
      .eq("lobby_id", currentLobby.id).eq("user_id", playerUserId);
  };

  if (!authReady) {
    return (
      <div className="fixed inset-0 bg-[#0f1420] flex items-center justify-center text-white">
        <div className="text-center">
          <div className="animate-pulse text-2xl font-bold text-[#f97316] mb-2">Connecting…</div>
          {error && <div className="text-red-400 text-sm">{error}</div>}
        </div>
      </div>
    );
  }

  // ========= IN LOBBY =========
  if (view === "in-lobby" && currentLobby) {
    const isHost = currentLobby.host_id === userId;

    return (
      <div className="fixed inset-0 bg-[#0a0f1a] text-white p-6 overflow-y-auto">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center justify-between mb-6">
            <button onClick={leaveLobby} className="px-4 py-2 rounded bg-white/10 hover:bg-white/20">← Leave</button>
            <h1 className="text-2xl font-bold">{currentLobby.name}</h1>
            <div className="text-right">
              <div className="text-xs text-gray-400">Lobby code</div>
              <div className="font-mono text-lg text-[#f97316] tracking-widest cursor-pointer"
                onClick={() => navigator.clipboard?.writeText(currentLobby.code)}
                title="Click to copy">{currentLobby.code}</div>
            </div>
          </div>

          {/* Settings */}
          <div className="bg-[#0f1420] border border-[#4a5568] rounded-xl p-4 mb-4">
            <div className="text-sm font-bold text-gray-300 mb-3">Game Settings {isHost ? "" : "(host only)"}</div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <div>
                <div className="text-xs text-gray-400 mb-1">Difficulty</div>
                <select disabled={!isHost} value={currentLobby.difficulty}
                  onChange={(e) => updateLobbySetting({ difficulty: e.target.value })}
                  className="w-full bg-[#1a2030] border border-[#4a5568] rounded px-2 py-1 disabled:opacity-60">
                  <option value="easy">Easy (weak AI)</option>
                  <option value="normal">Normal</option>
                  <option value="hard">Hard (strong AI)</option>
                </select>
              </div>
              <div>
                <div className="text-xs text-gray-400 mb-1">Mode</div>
                <select disabled={!isHost} value={currentLobby.mode}
                  onChange={(e) => updateLobbySetting({ mode: e.target.value })}
                  className="w-full bg-[#1a2030] border border-[#4a5568] rounded px-2 py-1 disabled:opacity-60">
                  <option value="ffa">Free for All</option>
                  <option value="teams">Teams</option>
                </select>
              </div>
              <div>
                <div className="text-xs text-gray-400 mb-1">Map</div>
                <select disabled={!isHost} value={currentLobby.map}
                  onChange={(e) => updateLobbySetting({ map: e.target.value })}
                  className="w-full bg-[#1a2030] border border-[#4a5568] rounded px-2 py-1 disabled:opacity-60">
                  <option value="world">World</option>
                  <option value="europe">Europe</option>
                  <option value="asia">Asia</option>
                  <option value="africa">Africa</option>
                  <option value="north_america">North America</option>
                  <option value="south_america">South America</option>
                  <option value="oceania">Oceania</option>
                </select>
              </div>
            </div>
          </div>

          {/* Players */}
          <div className="bg-[#0f1420] border border-[#4a5568] rounded-xl p-4 mb-4">
            <div className="text-sm font-bold text-gray-300 mb-3">Players ({players.length}/{currentLobby.max_players})</div>
            <div className="space-y-2">
              {players.map(p => (
                <div key={p.id} className="flex items-center gap-3 bg-[#1a2030] rounded px-3 py-2">
                  <div className="w-5 h-5 rounded" style={{ backgroundColor: p.color }} />
                  <div className="flex-1 font-medium">{p.display_name}</div>
                  {p.is_host && <span className="text-xs bg-[#f97316] text-white rounded px-2 py-0.5 font-bold">HOST</span>}
                  {isHost && !p.is_host && p.user_id !== userId && (
                    <button
                      onClick={() => kickPlayer(p.user_id)}
                      className="text-xs bg-red-600/80 hover:bg-red-600 text-white rounded px-2 py-1 font-bold transition"
                      title={`Kick ${p.display_name}`}
                    >
                      Kick
                    </button>
                  )}
                </div>
              ))}
              {Array.from({ length: Math.max(0, currentLobby.max_players - players.length) }).map((_, i) => (
                <div key={`empty-${i}`} className="flex items-center gap-3 bg-[#1a2030]/40 border border-dashed border-[#4a5568] rounded px-3 py-2 text-gray-500 italic">
                  Empty slot
                </div>
              ))}
            </div>
          </div>

          {error && <div className="text-red-400 text-sm mb-3">{error}</div>}

          <div className="flex gap-3">
            {(currentLobby as any).is_system ? (
              <div className="flex-1 py-3 rounded-xl bg-[#f97316]/20 border border-[#f97316] text-center font-bold text-[#f97316]">
                Game starts in {autoStartIn ?? 60}s
              </div>
            ) : isHost ? (
              <button onClick={startGame}
                className="flex-1 py-3 rounded-xl bg-[#f97316] hover:bg-[#ea580c] font-bold transition">
                Start Game
              </button>
            ) : (
              <div className="flex-1 py-3 rounded-xl bg-white/5 text-center text-gray-400">
                Waiting for host to start…
              </div>
            )}
          </div>
          <div className="text-xs text-gray-500 mt-3 text-center">
            Each player picks a different country and shares the same world.
          </div>
        </div>
      </div>
    );
  }

  // ========= BROWSE =========
  return (
    <div className="fixed inset-0 bg-[#0a0f1a] text-white p-6 overflow-y-auto">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <button onClick={onBack} className="px-4 py-2 rounded bg-white/10 hover:bg-white/20">← Back</button>
          <h1 className="text-3xl font-bold text-[#f97316]">Multiplayer Lobbies</h1>
          <div />
        </div>

        <div className="grid md:grid-cols-2 gap-4 mb-6">
          <div className="bg-[#0f1420] border border-[#4a5568] rounded-xl p-5">
            <div className="text-lg font-bold mb-3">Create new lobby</div>
            <p className="text-sm text-gray-400 mb-4">Host a game and invite friends with a code.</p>
            <button onClick={createLobby} disabled={busy}
              className="w-full py-3 rounded bg-[#f97316] hover:bg-[#ea580c] font-bold disabled:opacity-50">
              {busy ? "…" : "Create Lobby"}
            </button>
          </div>
          <div className="bg-[#0f1420] border border-[#4a5568] rounded-xl p-5">
            <div className="text-lg font-bold mb-3">Join with code</div>
            <input value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              placeholder="LOBBY CODE" maxLength={6}
              className="w-full bg-[#1a2030] border border-[#4a5568] rounded px-3 py-2 mb-3 font-mono tracking-widest text-center" />
            <button onClick={joinByCode} disabled={busy || !joinCode}
              className="w-full py-3 rounded bg-[#f97316] hover:bg-[#ea580c] font-bold disabled:opacity-50">
              Join
            </button>
          </div>
        </div>

        {error && <div className="text-red-400 text-sm mb-3">{error}</div>}

        <div className="bg-[#0f1420] border border-[#4a5568] rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="text-lg font-bold">Public lobbies</div>
            <button onClick={refreshLobbies} className="text-xs px-3 py-1 rounded bg-white/10 hover:bg-white/20">↻ Refresh</button>
          </div>
          {lobbies.length === 0 ? (
            <div className="py-8 text-center text-gray-500">No public lobbies yet — create one!</div>
          ) : (
            <div className="space-y-2">
              {lobbies.map(l => (
                <div key={l.id} className="flex items-center gap-3 bg-[#1a2030] rounded px-3 py-2">
                  <div className="flex-1">
                    <div className="font-medium">{l.name}</div>
                    <div className="text-xs text-gray-400">
                      {l.map} · {l.mode} · {l.difficulty} · code <span className="font-mono text-[#f97316]">{l.code}</span>
                    </div>
                  </div>
                  <button onClick={() => joinLobby(l)} disabled={busy}
                    className="px-4 py-1.5 rounded bg-[#f97316] hover:bg-[#ea580c] text-sm font-bold disabled:opacity-50">
                    Join
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
