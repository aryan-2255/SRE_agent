import { useSyncExternalStore } from "react";
import { engine } from "./engine";

export function useEngine() {
  return useSyncExternalStore(engine.subscribe, engine.getSnapshot);
}
