const POST_AUTH_DESTINATION_KEY = "reelvotes:post-auth-destination";

type PostAuthDestination = {
  pathname: string;
  search: string;
  hash: string;
  createdAt: number;
};

function normalizePathname(pathname: string): string {
  const value = String(pathname || "").trim();
  if (!value) return "/";
  return value.startsWith("/") ? value : `/${value}`;
}

function buildDestination(
  pathname: string,
  options?: { search?: string; hash?: string },
): PostAuthDestination {
  const search = String(options?.search || "").trim();
  const hash = String(options?.hash || "").trim();

  return {
    pathname: normalizePathname(pathname),
    search: search.startsWith("?") || !search ? search : `?${search}`,
    hash: hash.startsWith("#") || !hash ? hash : `#${hash}`,
    createdAt: Date.now(),
  };
}

export function rememberPostAuthDestination(
  pathname: string,
  options?: { search?: string; hash?: string },
) {
  if (typeof window === "undefined") return;
  try {
    const destination = buildDestination(pathname, options);
    window.sessionStorage.setItem(POST_AUTH_DESTINATION_KEY, JSON.stringify(destination));
  } catch {
    // Ignore storage failures.
  }
}

export function rememberCurrentLocationForPostAuth() {
  if (typeof window === "undefined") return;
  rememberPostAuthDestination(window.location.pathname, {
    search: window.location.search,
    hash: window.location.hash,
  });
}

export function readPostAuthDestination(): PostAuthDestination | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.sessionStorage.getItem(POST_AUTH_DESTINATION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PostAuthDestination> | null;
    const pathname = normalizePathname(String(parsed?.pathname || ""));
    const search = String(parsed?.search || "");
    const hash = String(parsed?.hash || "");

    return {
      pathname,
      search: search.startsWith("?") || !search ? search : `?${search}`,
      hash: hash.startsWith("#") || !hash ? hash : `#${hash}`,
      createdAt: Number(parsed?.createdAt || 0),
    };
  } catch {
    return null;
  }
}

export function clearPostAuthDestination() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(POST_AUTH_DESTINATION_KEY);
  } catch {
    // Ignore storage failures.
  }
}

export function navigateToPostAuthDestination(): boolean {
  if (typeof window === "undefined") return false;

  const destination = readPostAuthDestination();
  if (!destination) return false;

  const targetUrl = `${destination.pathname}${destination.search}${destination.hash}`;
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;

  clearPostAuthDestination();

  if (targetUrl === currentUrl) {
    return false;
  }

  window.location.assign(targetUrl);
  return true;
}