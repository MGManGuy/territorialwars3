-- Enable realtime so host sees joins/leaves and difficulty updates instantly
ALTER PUBLICATION supabase_realtime ADD TABLE public.lobbies;
ALTER PUBLICATION supabase_realtime ADD TABLE public.lobby_players;

-- Allow lobby host to kick any player from their lobby
CREATE POLICY "Host can kick players from own lobby"
ON public.lobby_players
FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.lobbies
    WHERE lobbies.id = lobby_players.lobby_id
      AND lobbies.host_id = auth.uid()
  )
);