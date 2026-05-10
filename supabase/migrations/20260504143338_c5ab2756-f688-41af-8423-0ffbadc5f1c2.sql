-- Multiplayer lobbies
CREATE TABLE public.lobbies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  host_id UUID NOT NULL,
  name TEXT NOT NULL DEFAULT 'New Lobby',
  map TEXT NOT NULL DEFAULT 'world',
  difficulty TEXT NOT NULL DEFAULT 'normal',
  mode TEXT NOT NULL DEFAULT 'ffa',
  economy TEXT NOT NULL DEFAULT 'classic',
  max_players INT NOT NULL DEFAULT 8,
  status TEXT NOT NULL DEFAULT 'waiting',
  is_public BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ
);

CREATE INDEX idx_lobbies_status ON public.lobbies(status);
CREATE INDEX idx_lobbies_code ON public.lobbies(code);

CREATE TABLE public.lobby_players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lobby_id UUID NOT NULL REFERENCES public.lobbies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  display_name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#f97316',
  country_id TEXT,
  is_ready BOOLEAN NOT NULL DEFAULT false,
  is_host BOOLEAN NOT NULL DEFAULT false,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (lobby_id, user_id)
);

CREATE INDEX idx_lobby_players_lobby ON public.lobby_players(lobby_id);

ALTER TABLE public.lobbies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lobby_players ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public lobbies viewable by all authenticated"
ON public.lobbies FOR SELECT TO authenticated
USING (true);

CREATE POLICY "Authenticated users can create lobbies"
ON public.lobbies FOR INSERT TO authenticated
WITH CHECK (auth.uid() = host_id);

CREATE POLICY "Host can update own lobby"
ON public.lobbies FOR UPDATE TO authenticated
USING (auth.uid() = host_id);

CREATE POLICY "Host can delete own lobby"
ON public.lobbies FOR DELETE TO authenticated
USING (auth.uid() = host_id);

CREATE POLICY "Players viewable by anyone authenticated"
ON public.lobby_players FOR SELECT TO authenticated
USING (true);

CREATE POLICY "User can join lobbies as themselves"
ON public.lobby_players FOR INSERT TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "User can update their own lobby player row"
ON public.lobby_players FOR UPDATE TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "User can leave (delete own player row)"
ON public.lobby_players FOR DELETE TO authenticated
USING (auth.uid() = user_id);

ALTER PUBLICATION supabase_realtime ADD TABLE public.lobbies;
ALTER PUBLICATION supabase_realtime ADD TABLE public.lobby_players;
ALTER TABLE public.lobbies REPLICA IDENTITY FULL;
ALTER TABLE public.lobby_players REPLICA IDENTITY FULL;