import {
	browserLocalPersistence,
	browserSessionPersistence,
	getAuth,
	GoogleAuthProvider,
	getRedirectResult,
	inMemoryPersistence,
	signInWithPopup,
	onAuthStateChanged,
	setPersistence,
	signOut,
} from "firebase/auth";
import { firebaseApp } from "./firebase-core";

// Split out of firebase.ts so pages that never sign anyone in (vote, chat,
// suggest, etc.) don't pull the Auth SDK into their bundle.
export const auth = getAuth(firebaseApp);

function buildGoogleProvider(options?: { forceAccountSelection?: boolean }) {
	const provider = new GoogleAuthProvider();
	if (options?.forceAccountSelection) {
		provider.setCustomParameters({ prompt: "select_account" });
	}
	return provider;
}

let authPersistencePromise: Promise<void> | null = null;

async function ensureAuthPersistence() {
	if (authPersistencePromise) {
		return authPersistencePromise;
	}

	authPersistencePromise = (async () => {
		try {
			await setPersistence(auth, browserLocalPersistence);
			return;
		} catch {
			// Fall through to session persistence.
		}

		try {
			await setPersistence(auth, browserSessionPersistence);
			return;
		} catch {
			// Fall through to in-memory as a last resort.
		}

		await setPersistence(auth, inMemoryPersistence);
	})();

	return authPersistencePromise;
}

export function isPopupSignInCancellation(error: unknown): boolean {
	const code = String((error as any)?.code || "").toLowerCase();
	const message = String((error as any)?.message || "").toLowerCase();
	return code === "auth/cancelled-popup-request" || code === "auth/popup-closed-by-user" ||
		message.includes("cancelled-popup-request") || message.includes("popup-closed-by-user");
}

function shouldFallbackToRedirect(error: unknown): boolean {
	const code = String((error as any)?.code || "").toLowerCase();
	const message = String((error as any)?.message || "").toLowerCase();
	return code === "auth/popup-blocked" ||
		code === "auth/popup-closed-by-user" ||
		code === "auth/cancelled-popup-request" ||
		code === "auth/operation-not-supported-in-this-environment" ||
		code === "auth/web-storage-unsupported" ||
		message.includes("popup blocked") ||
		message.includes("popup-closed-by-user") ||
		message.includes("operation-not-supported-in-this-environment");
}

export async function signInWithGoogle(options?: { forceAccountSelection?: boolean }) {
	await ensureAuthPersistence();
	const provider = buildGoogleProvider(options);

	try {
		return await signInWithPopup(auth, provider);
	} catch (error) {
		if (shouldFallbackToRedirect(error)) {
			throw error;
		}
		throw error;
	}
}

if (typeof window !== "undefined") {
	void ensureAuthPersistence()
		.then(() => getRedirectResult(auth))
		.catch((error) => {
		const code = String((error as any)?.code || "").toLowerCase();
		if (code === "auth/no-auth-event") {
			return;
		}
		console.error("Google redirect sign-in failed:", error);
		});
}

export { signInWithPopup, onAuthStateChanged, signOut };
