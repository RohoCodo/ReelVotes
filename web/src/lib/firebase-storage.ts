import { getStorage } from "firebase/storage";
import { firebaseApp } from "./firebase";

// Split out of firebase.ts so pages that never upload/read Storage files
// don't pull the Storage SDK into their bundle — only ReelSuccess needs it.
export const storage = getStorage(firebaseApp);
