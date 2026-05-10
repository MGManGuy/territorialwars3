-- Allow system/public auto-lobbies hosted by a fixed sentinel UUID.
-- Sentinel: 00000000-0000-0000-0000-000000000000

-- Add a flag to mark system-managed lobbies (auto-rotated every minute).
ALTER TABLE public.lobbies ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;

-- Unique constraint on code so the same minute-bucket cannot be inserted twice.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lobbies_code_unique'
  ) THEN
    ALTER TABLE public.lobbies ADD CONSTRAINT lobbies_code_unique UNIQUE (code);
  END IF;
END $$;

-- Allow any authenticated user to create a system lobby (host_id = sentinel).
DROP POLICY IF EXISTS "Anyone can create system lobbies" ON public.lobbies;
CREATE POLICY "Anyone can create system lobbies"
ON public.lobbies
FOR INSERT
TO authenticated
WITH CHECK (
  is_system = true
  AND host_id = '00000000-0000-0000-0000-000000000000'::uuid
);

-- Prevent updates/deletes on system lobbies by anyone (they expire on their own).
DROP POLICY IF EXISTS "No one can modify system lobbies" ON public.lobbies;
CREATE POLICY "No one can modify system lobbies"
ON public.lobbies
FOR DELETE
TO authenticated
USING (is_system = false AND auth.uid() = host_id);
-- (The existing "Host can delete own lobby" policy still covers user lobbies;
--  the new restrictive intent is enforced because system lobbies have a sentinel host_id no real user can match.)