import { supabase } from "@/integrations/supabase/client";
import type { BuildingType } from "./types";

export type MpEvent =
  | { type: "build"; from: string; countryId: string; building: { type: BuildingType; icon: string; x?: number; y?: number } }
  | { type: "war_declared"; from: string; fromName?: string; to: string; targetCountryId: string }
  | { type: "war_ended"; from: string; fromName?: string; to: string; targetCountryId: string }
  | { type: "attack_started"; from: string; fromName: string; targetCountryId: string; troops: number }
  | { type: "country_captured"; from: string; fromName?: string; previousOwner: string | null; countryId: string; newOwner: string; newOwnerColor: string; troopsLeft: number }
  | { type: "troop_loss"; from: string; troops: number }
  | {
      type: "battle_state";
      from: string;
      fromName: string;
      targetCountryId: string;
      attacker: number;
      defender: number;
      attackerTanks: number;
      attackerPlanes: number;
      defenderPlanes: number;
      progress: number;
      defenseMult: number;
      forceAttackUntil?: number;
      defenderLastStandUntil?: number;
    }
  | { type: "battle_ended"; from: string; targetCountryId: string }
  | { type: "defender_last_stand"; from: string; targetCountryId: string; until: number };

export interface LobbyChannel {
  broadcast: (event: MpEvent) => void;
  leave: () => void;
}

export function joinLobbyChannel(
  lobbyId: string,
  onEvent: (event: MpEvent) => void
): LobbyChannel {
  const channel = supabase.channel(`lobby-game:${lobbyId}`, {
    config: { broadcast: { self: false } },
  });
  channel.on("broadcast", { event: "game" }, (payload) => {
    const data = payload.payload as MpEvent;
    onEvent(data);
  });
  channel.subscribe();
  return {
    broadcast: (event: MpEvent) => {
      channel.send({ type: "broadcast", event: "game", payload: event });
    },
    leave: () => {
      supabase.removeChannel(channel);
    },
  };
}
