import { useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { auth, onAuthStateChanged, signInWithGoogle, signOut } from "../lib/firebase-auth";

export default function AccountPanel() {
  const [authUser, setAuthUser] = useState<User | null | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => setAuthUser(user));
    return () => unsubscribe();
  }, []);

  async function handleSignIn() {
    setPending(true);
    setErrorMessage("");
    try {
      await signInWithGoogle();
    } catch (error) {
      setErrorMessage(String((error as any)?.message || "Could not sign in right now."));
    } finally {
      setPending(false);
    }
  }

  async function handleSignOut() {
    setPending(true);
    setErrorMessage("");
    try {
      await signOut(auth);
    } catch (error) {
      setErrorMessage(String((error as any)?.message || "Could not sign out right now."));
    } finally {
      setPending(false);
    }
  }

  if (authUser === undefined) {
    return (
      <div className="rounded-2xl border border-line bg-paper p-6">
        <div className="skeleton h-5 w-40 rounded" />
        <div className="skeleton mt-3 h-4 w-56 rounded" />
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-line bg-paper p-6">
      {authUser ? (
        <>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Signed in</p>
          <h2 className="mt-2 font-display text-2xl font-semibold text-ink">Your account</h2>
          <p className="mt-2 text-sm text-ink-soft">{authUser.displayName || authUser.email || "ReelVotes member"}</p>
          {authUser.email && <p className="mt-1 text-xs text-ink-faint">{authUser.email}</p>}

          <button
            type="button"
            disabled={pending}
            onClick={handleSignOut}
            className="mt-6 rounded-full border border-line px-4 py-2 text-sm font-semibold text-ink-soft transition-colors hover:border-marquee hover:text-marquee disabled:opacity-60"
          >
            {pending ? "Signing out..." : "Sign Out"}
          </button>
        </>
      ) : (
        <>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Account</p>
          <h2 className="mt-2 font-display text-2xl font-semibold text-ink">Sign in to view your account</h2>
          <p className="mt-2 text-sm text-ink-soft">Use Google sign-in to manage your ReelVotes account.</p>

          <button
            type="button"
            disabled={pending}
            onClick={handleSignIn}
            className="mt-6 rounded-full bg-marquee px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-marquee-dark disabled:opacity-60"
          >
            {pending ? "Opening sign in..." : "Sign In"}
          </button>
        </>
      )}

      {errorMessage && (
        <p className="mt-4 rounded-lg border border-red-300/30 bg-red-900/20 px-3 py-2 text-xs text-red-200">{errorMessage}</p>
      )}
    </div>
  );
}
