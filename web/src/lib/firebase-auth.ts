import {
	getAuth,
	GoogleAuthProvider,
	signInWithPopup,
	signInWithRedirect,
	onAuthStateChanged,
	signOut,
} from "firebase/auth";
import { firebaseApp } from "./firebase-core";

// Split out of firebase.ts so pages that never sign anyone in (vote, chat,
// suggest, etc.) don't pull the Auth SDK into their bundle.
export const auth = getAuth(firebaseApp);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

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
		code === "auth/cancelled-popup-request" ||
		code === "auth/operation-not-supported-in-this-environment" ||
		message.includes("popup blocked") ||
		message.includes("operation-not-supported-in-this-environment");
}

export async function signInWithGoogle() {
	try {
		return await signInWithPopup(auth, googleProvider);
	} catch (error) {
		if (shouldFallbackToRedirect(error)) {
			await signInWithRedirect(auth, googleProvider);
			return null;
		}
		throw error;
	}
}

export { signInWithPopup, onAuthStateChanged, signOut };
