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

const AUTH_ERROR_STORAGE_KEY = "reelvotes:last-auth-error";

export type AuthDebugError = {
	code: string;
	message: string;
	source: string;
	at: number;
};

function toAuthDebugError(error: unknown, source: string): AuthDebugError {
	const code = String((error as any)?.code || "auth/unknown").trim() || "auth/unknown";
	const message = String((error as any)?.message || "Unknown authentication error.").trim() || "Unknown authentication error.";
	return {
		code,
		message,
		source,
		at: Date.now(),
	};
}

function reportAuthError(error: unknown, source: string) {
	if (typeof window === "undefined") {
		return;
	}

	const payload = toAuthDebugError(error, source);
	try {
		window.sessionStorage.setItem(AUTH_ERROR_STORAGE_KEY, JSON.stringify(payload));
	} catch {
		// Ignore storage failures.
	}

	window.dispatchEvent(new CustomEvent("reelvotes:auth-error", { detail: payload }));
}

export function readLastAuthError(): AuthDebugError | null {
	if (typeof window === "undefined") {
		return null;
	}

	try {
		const raw = window.sessionStorage.getItem(AUTH_ERROR_STORAGE_KEY);
		if (!raw) {
			return null;
		}
		const parsed = JSON.parse(raw) as Partial<AuthDebugError> | null;
		return {
			code: String(parsed?.code || "auth/unknown"),
			message: String(parsed?.message || "Unknown authentication error."),
			source: String(parsed?.source || "unknown"),
			at: Number(parsed?.at || 0),
		};
	} catch {
		return null;
	}
}

export function clearLastAuthError() {
	if (typeof window === "undefined") {
		return;
	}

	try {
		window.sessionStorage.removeItem(AUTH_ERROR_STORAGE_KEY);
	} catch {
		// Ignore storage failures.
	}
}

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
	const persistenceReady = ensureAuthPersistence();
	const provider = buildGoogleProvider(options);

	try {
		const result = await signInWithPopup(auth, provider);
		clearLastAuthError();
		return result;
	} catch (error) {
		await persistenceReady.catch(() => undefined);
		if (shouldFallbackToRedirect(error)) {
			reportAuthError(error, "popup");
			throw error;
		}
		reportAuthError(error, "popup");
		throw error;
	}
}

if (typeof window !== "undefined") {
	void ensureAuthPersistence()
		.then(() => getRedirectResult(auth))
		.then((result) => {
			if (result?.user) {
				clearLastAuthError();
			}
		})
		.catch((error) => {
		const code = String((error as any)?.code || "").toLowerCase();
		if (code === "auth/no-auth-event") {
			return;
		}
		if (code === "auth/missing-initial-state") {
			reportAuthError(error, "redirect-result");
			return;
		}
		reportAuthError(error, "redirect-result");
		console.error("Google redirect sign-in failed:", error);
		});
}

export { signInWithPopup, onAuthStateChanged, signOut };
