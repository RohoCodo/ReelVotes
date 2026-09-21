import {
	browserLocalPersistence,
	browserSessionPersistence,
	getAuth,
	GoogleAuthProvider,
	getRedirectResult,
	inMemoryPersistence,
	signInWithRedirect,
	type User,
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
		code === "auth/operation-not-supported-in-this-environment" ||
		code === "auth/web-storage-unsupported" ||
		message.includes("popup blocked") ||
		message.includes("operation-not-supported-in-this-environment");
}

function isIosFamilyDevice(): boolean {
	if (typeof navigator === "undefined") return false;
	const userAgent = navigator.userAgent || "";
	const platform = navigator.platform || "";
	const maxTouchPoints = Number(navigator.maxTouchPoints || 0);
	return /iphone|ipad|ipod/i.test(userAgent) ||
		(platform === "MacIntel" && maxTouchPoints > 1);
}

function isEmbeddedInAppBrowser(): boolean {
	if (typeof navigator === "undefined") return false;
	const userAgent = navigator.userAgent || "";
	return /fban|fbav|instagram|line\//i.test(userAgent) ||
		/\bwv\b/i.test(userAgent) ||
		/crios/i.test(userAgent) ||
		/gsa/i.test(userAgent);
}

function shouldPreferRedirectSignIn(): boolean {
	if (typeof window === "undefined") return false;
	return isIosFamilyDevice() || isEmbeddedInAppBrowser();
}

export async function waitForSignedInUser(timeoutMs = 4000): Promise<User | null> {
	if (auth.currentUser) {
		return auth.currentUser;
	}

	return await new Promise((resolve) => {
		let settled = false;
		const timeoutId = window.setTimeout(() => {
			if (settled) return;
			settled = true;
			unsubscribe();
			resolve(auth.currentUser);
		}, timeoutMs);

		const unsubscribe = onAuthStateChanged(auth, (user) => {
			if (!user || settled) return;
			settled = true;
			window.clearTimeout(timeoutId);
			unsubscribe();
			resolve(user);
		});
	});
}

export async function signInWithGoogle(options?: { forceAccountSelection?: boolean }) {
	await ensureAuthPersistence();
	const provider = buildGoogleProvider(options);

	if (shouldPreferRedirectSignIn()) {
		await signInWithRedirect(auth, provider);
		return null;
	}

	try {
		return await signInWithPopup(auth, provider);
	} catch (error) {
		if (shouldFallbackToRedirect(error)) {
			await signInWithRedirect(auth, provider);
			return null;
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
