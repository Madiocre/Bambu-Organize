/** Thin fetch wrapper: unwraps the API's `{ error }` convention into a throw. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers:
      init?.body instanceof FormData
        ? init.headers
        : { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `Request failed (${response.status})`;
    throw new Error(message);
  }

  return payload as T;
}

let toastTimer: number | undefined;

export function toast(message: string, kind: "info" | "error" = "info"): void {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.className = kind === "error" ? "show error" : "show";
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.className = "";
  }, kind === "error" ? 6000 : 3000);
}
