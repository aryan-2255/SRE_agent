import { useSyncExternalStore } from "react";

/** Which agent or system the viewer is looking at: hover previews it, click pins it. Shared by the map, rail and feeds. */
let hover: string | null = null;
let pinned: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function setFocus(id: string | null, pin: boolean) {
  if (pin) { pinned = id; hover = null; }
  else hover = id;
  emit();
}
export const getFocus = () => hover ?? pinned;
export const getPinned = () => pinned;

export function useFocus(): [string | null, (id: string | null, pin: boolean) => void, string | null] {
  const f = useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, getFocus);
  const p = useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, getPinned);
  return [f, setFocus, p];
}
