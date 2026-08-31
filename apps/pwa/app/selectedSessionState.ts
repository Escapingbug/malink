export const SELECTED_SESSION_STORAGE_PREFIX =
  "malink.ui.selected-session.v1";
export const SELECTED_SESSION_ROUTE_STORAGE_PREFIX =
  "malink.ui.selected-session-route.v2";

export type SelectedSessionRoute = {
  sessionId: string;
  projectId?: string;
};

type SelectionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function selectedSessionStorageKey(scope: string): string {
  if (!scope || scope.length > 4_096) {
    throw new Error("Selected-session scope is invalid.");
  }
  return `${SELECTED_SESSION_STORAGE_PREFIX}.${encodeURIComponent(scope)}`;
}

export function selectedSessionRouteStorageKey(scope: string): string {
  if (!scope || scope.length > 4_096) {
    throw new Error("Selected-session scope is invalid.");
  }
  return `${SELECTED_SESSION_ROUTE_STORAGE_PREFIX}.${encodeURIComponent(scope)}`;
}

export function readSelectedSession(
  storage: Pick<Storage, "getItem"> | null | undefined,
  scope: string,
): string | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(selectedSessionStorageKey(scope));
    return value && value.length <= 512 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Reads the project-qualified route used by current clients. The old scalar
 * value remains a compatibility fallback so an upgrade never forgets the
 * user's selected session.
 */
export function readSelectedSessionRoute(
  storage: Pick<Storage, "getItem"> | null | undefined,
  scope: string,
): SelectedSessionRoute | null {
  if (!storage) return null;
  try {
    const encoded = storage.getItem(selectedSessionRouteStorageKey(scope));
    if (encoded) {
      const value = JSON.parse(encoded) as Partial<SelectedSessionRoute>;
      if (
        typeof value.sessionId === "string" &&
        value.sessionId.length > 0 &&
        value.sessionId.length <= 512 &&
        (value.projectId === undefined ||
          (typeof value.projectId === "string" &&
            value.projectId.length > 0 &&
            value.projectId.length <= 512))
      ) {
        return {
          sessionId: value.sessionId,
          ...(value.projectId ? { projectId: value.projectId } : {}),
        };
      }
    }
  } catch {
    // Fall through to the v1 scalar value.
  }
  const sessionId = readSelectedSession(storage, scope);
  return sessionId ? { sessionId } : null;
}

export function writeSelectedSession(
  storage: SelectionStorage | null | undefined,
  scope: string,
  sessionId: string | null,
): boolean {
  if (!storage) return false;
  try {
    const key = selectedSessionStorageKey(scope);
    if (sessionId === null) {
      storage.removeItem(key);
    } else {
      if (!sessionId || sessionId.length > 512) return false;
      storage.setItem(key, sessionId);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Dual-writes the new exact route and the legacy scalar selection. Older
 * clients continue to restore the same session ID, while current clients can
 * disambiguate legacy maintenance sessions shared by multiple projects.
 */
export function writeSelectedSessionRoute(
  storage: SelectionStorage | null | undefined,
  scope: string,
  route: SelectedSessionRoute | null,
): boolean {
  if (!storage) return false;
  try {
    const routeKey = selectedSessionRouteStorageKey(scope);
    if (route === null) {
      storage.removeItem(routeKey);
      return writeSelectedSession(storage, scope, null);
    }
    if (
      !route.sessionId ||
      route.sessionId.length > 512 ||
      (route.projectId !== undefined &&
        (!route.projectId || route.projectId.length > 512))
    ) {
      return false;
    }
    storage.setItem(routeKey, JSON.stringify(route));
    return writeSelectedSession(storage, scope, route.sessionId);
  } catch {
    return false;
  }
}
