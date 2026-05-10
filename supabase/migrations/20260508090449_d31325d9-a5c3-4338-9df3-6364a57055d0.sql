CREATE UNIQUE INDEX IF NOT EXISTS lobby_players_unique_country_per_lobby
ON public.lobby_players (lobby_id, country_id)
WHERE country_id IS NOT NULL;