## Goal

Make a multiplayer lobby a single shared world: when one player builds, declares war, or conquers a country, every other player sees it on their map and in their state.

## Approach

Add a single per-lobby Supabase Realtime broadcast channel (`lobby:{lobbyId}`) that all clients in `GameMap` join. The local simulator stays — but every action a human takes is broadcast as an event, and incoming events are applied to local `gameState`. No new tables needed.

## Event types

```text
build           { countryId, building }        — toggles UI building list for everyone
war_declared    { from, to }                   — adds war for both sides
war_ended       { from, to }                   — peace / surrender
attack_started  { from, fromCountry, target,   — defender gets a "You are under attack!" toast
                  troops }
country_captured{ countryId, newOwner,         — flips ownership + troop counts on every map
                  newOwnerColor, troopsLeft }
troop_transfer  { from, to, amount }           — keeps human troop pools in sync after combat
```

`from`/`to`/`newOwner` use the same owner id format already in state: `"player"` for self, `"human-{userId}"` for other humans, `"bot-N"` for bots.

## Implementation steps

1. **`src/game/multiplayerSync.ts` (new)** — small wrapper that exposes `joinLobbyChannel(lobbyId, userId, onEvent)` returning `{ broadcast(event), leave() }`. Uses `supabase.channel(...).on('broadcast', { event: 'game' }, ...)`.

2. **`GameMap.tsx`** — wire it in:
   - On mount (when `lobbyId` set): join the channel, store ref to `broadcast`.
   - Translate the local owner id `"player"` to `"human-{myUserId}"` on outgoing events, and back to `"player"` on incoming events that target me.
   - Hook outgoing broadcasts at the existing `setGameState` call sites:
     - building placed (~line 805 area)
     - declare war (line 997) and peace (line 1025)
     - country captured by player (line 519 — `target.owner = "player"`)
     - attack started — when battle UI opens
   - Handle incoming events in a `useEffect` that mutates `gameStateRef.current` via `setGameState((prev) => ...)` per event type.
   - Show a toast notification on `attack_started` targeting any of the local player's countries.

3. **Conquest by other humans** — when an incoming `country_captured` says newOwner is me, no-op (I already own it locally). When it's another human, switch the country's owner/color in local state. When the captured country was MINE, surface a "You lost {country}!" notification and remove it from my owned list (state already aggregates by `owner === "player"`, so just flipping `owner` is enough).

4. **War sync** — `war_declared` / `war_ended` between two humans: each side adds/removes the war entry against the OTHER human's primary country. `setGameState` mutates `wars` and the relations on those countries.

5. **Defender experience** — on `attack_started`, show a red banner "⚠ {AttackerName} is attacking {YourCountry} with {N} troops!" via existing `setNotification`. No combat UI on defender side; result arrives as `country_captured` or `troop_transfer`.

6. **Builds visible** — on incoming `build`, push the building into `countries[countryId].buildings` so the inspector shows it for everyone.

## Out of scope (intentional)

- Server-authoritative combat (still resolved on attacker's client; result is broadcast). This matches the "Full PvP combat" choice without a full rewrite.
- Anti-cheat / desync recovery. If two players conquer the same country in the same tick, last-write-wins.
- Bot actions are not broadcast — every client still simulates bots locally from the same seed, so bot territory drifts. Acceptable for now; can be addressed by making bots authoritative on the host later.

## Files touched

- `src/game/multiplayerSync.ts` (new, ~60 lines)
- `src/components/game/GameMap.tsx` (add channel join + event hooks at ~6 existing setGameState sites)

No DB migration, no edge functions. All purely realtime.
