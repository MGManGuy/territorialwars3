import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/auth")({
  component: AuthPage,
  ssr: false,
});

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // If already signed in, bounce home.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/" });
    });
  }, [navigate]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { display_name: name || email.split("@")[0] },
            emailRedirectTo: `${window.location.origin}/`,
          },
        });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
      navigate({ to: "/" });
    } catch (err: any) {
      setError(err.message || "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-[#0a0f1a] text-white flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-[#0f1420] border border-[#4a5568] rounded-xl p-6 shadow-2xl">
        <h1 className="text-3xl font-extrabold text-[#f97316] mb-1 text-center">FrontWars</h1>
        <p className="text-center text-sm text-gray-400 mb-6">
          {mode === "signup" ? "Create an account to play multiplayer" : "Sign in to play multiplayer"}
        </p>

        <form onSubmit={submit} className="space-y-3">
          {mode === "signup" && (
            <div>
              <label className="text-xs text-gray-400 block mb-1">Display name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your in-game name"
                className="w-full bg-[#1a2030] border border-[#4a5568] rounded px-3 py-2"
              />
            </div>
          )}
          <div>
            <label className="text-xs text-gray-400 block mb-1">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full bg-[#1a2030] border border-[#4a5568] rounded px-3 py-2"
            />
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Password</label>
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 6 characters"
              className="w-full bg-[#1a2030] border border-[#4a5568] rounded px-3 py-2"
            />
          </div>

          {error && <div className="text-red-400 text-sm">{error}</div>}

          <button
            type="submit"
            disabled={busy}
            className="w-full py-3 rounded-xl bg-[#f97316] hover:bg-[#ea580c] font-bold disabled:opacity-50"
          >
            {busy ? "…" : mode === "signup" ? "Create account" : "Sign in"}
          </button>
        </form>

        <button
          onClick={() => setMode(mode === "signup" ? "signin" : "signup")}
          className="w-full mt-4 text-sm text-gray-400 hover:text-white"
        >
          {mode === "signup" ? "Already have an account? Sign in" : "No account? Sign up"}
        </button>

        <button
          onClick={() => navigate({ to: "/" })}
          className="w-full mt-2 text-xs text-gray-500 hover:text-gray-300"
        >
          ← Back to game
        </button>
      </div>
    </div>
  );
}
