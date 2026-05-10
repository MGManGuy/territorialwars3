import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import MainMenu from "@/components/game/MainMenu";
import CountrySelect from "@/components/game/CountrySelect";
import GameMap from "@/components/game/GameMap";
import MultiplayerLobby from "@/components/game/MultiplayerLobby";

export const Route = createFileRoute("/")({
  component: GamePage,
  // Game is heavily client-side (d3, window APIs). Skip SSR.
  ssr: false,
});

type Phase = "menu" | "multiplayer" | "select" | "game";
type Difficulty = "easy" | "normal" | "hard";

function GamePage() {
  const [phase, setPhase] = useState<Phase>("menu");
  const [selectedCountry, setSelectedCountry] = useState<string | null>(null);
  const [difficulty, setDifficulty] = useState<Difficulty>("easy");
  const [playerName, setPlayerName] = useState<string>("Player");
  const [autoJoinLobbyId, setAutoJoinLobbyId] = useState<string | null>(null);
  const [lobbyId, setLobbyId] = useState<string | null>(null);
  const [selectionEndsAt, setSelectionEndsAt] = useState<string | null>(null);

  return (
    <div className="w-screen h-screen overflow-hidden bg-[#1a1f2e]">
      {phase === "menu" && (
        <MainMenu
          onSinglePlayer={(diff) => {
            setDifficulty(diff);
            setLobbyId(null);
            setSelectionEndsAt(null);
            setPhase("select");
          }}
          onMultiplayer={(name) => {
            setPlayerName(name);
            setAutoJoinLobbyId(null);
            setPhase("multiplayer");
          }}
          onJoinPublic={(name, lobbyId) => {
            setPlayerName(name);
            setAutoJoinLobbyId(lobbyId);
            // Public auto-lobbies have no host to press Start — drop the
            // player straight into the game (country select) instead of
            // the waiting room.
            setDifficulty("normal");
            setLobbyId(lobbyId);
            setSelectionEndsAt(null);
            setPhase("select");
          }}
        />
      )}
      {phase === "multiplayer" && (
        <MultiplayerLobby
          playerName={playerName}
          autoJoinLobbyId={autoJoinLobbyId}
          onBack={() => setPhase("menu")}
          onStartGame={({ difficulty: diff, lobbyId: lid, selectionEndsAt: endsAt }) => {
            setDifficulty(diff);
            setLobbyId(lid);
            setSelectionEndsAt(endsAt);
            setPhase("select");
          }}
        />
      )}
      {phase === "select" && (
        <CountrySelect
          lobbyId={lobbyId}
          selectionEndsAt={selectionEndsAt}
          onConfirm={(countryId) => {
            setSelectedCountry(countryId);
            setSelectionEndsAt(null);
            setPhase("game");
          }}
        />
      )}
      {phase === "game" && selectedCountry && (
        <GameMap
          playerCountryId={selectedCountry}
          difficulty={difficulty}
          lobbyId={lobbyId}
          onExit={() => setPhase("menu")}
        />
      )}
    </div>
  );
}
