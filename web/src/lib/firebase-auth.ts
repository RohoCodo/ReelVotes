import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut } from "firebase/auth";
import { firebaseApp } from "./firebase";

// Split out of firebase.ts so pages that never sign anyone in (vote, chat,
// suggest, etc.) don't pull the Auth SDK into their bundle.
export const auth = getAuth(firebaseApp);
export const googleProvider = new GoogleAuthProvider();

export { signInWithPopup, onAuthStateChanged, signOut };
