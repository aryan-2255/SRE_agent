import { useCallback, useEffect, useState } from "react";
import { Toaster, toast } from "sonner";
import { WarningOctagon, Signature, CheckCircle, XCircle } from "@phosphor-icons/react";
import { engine } from "./engine/engine";
import Header from "./components/Header";
import StageRail from "./components/StageRail";
import { Watcher, SyntheticCustomer, ToolTraffic, BlindBanner } from "./components/LeftColumn";
import CenterStage from "./components/CenterStage";
import { Approval, Conversation, Evidence } from "./components/RightColumn";
import Timeline from "./components/Timeline";
import Drawer from "./components/Drawer";
import AgentPanel from "./components/AgentPanel";

const TOAST_ICON = {
  alert: <WarningOctagon size={18} weight="fill" style={{ color: "var(--red)" }} />,
  human: <Signature size={18} weight="fill" style={{ color: "var(--amber)" }} />,
  done: <CheckCircle size={18} weight="fill" style={{ color: "var(--go)" }} />,
  stop: <XCircle size={18} weight="fill" style={{ color: "var(--red)" }} />,
};

export default function App() {
  const [drawer, setDrawer] = useState(false);
  const closeDrawer = useCallback(() => setDrawer(false), []);

  useEffect(() => {
    engine.start();
    const key = (e: KeyboardEvent) => {
      if (e.code === "Space" && engine.replaying && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); engine.togglePause(); }
    };
    window.addEventListener("keydown", key);
    const off = engine.onToast((t) => toast(t.title, { description: t.body, icon: TOAST_ICON[t.tone], duration: t.tone === "human" ? 7000 : 4500 }));
    return () => { off(); window.removeEventListener("keydown", key); };
  }, []);

  return (
    <div className="grid h-full grid-rows-[64px_auto_46px_minmax(0,1fr)_auto] overflow-hidden">
      <Header onMenu={() => setDrawer(true)} />
      <BlindBanner />
      <StageRail />
      <main className="grid min-h-0 grid-cols-[clamp(236px,16.5vw,330px)_minmax(0,1fr)_clamp(292px,21vw,420px)] gap-3 p-3 min-[1700px]:gap-4 min-[1700px]:p-4">
        <aside className="flex min-h-0 flex-col gap-3 min-[1700px]:gap-4">
          <Watcher />
          <SyntheticCustomer />
          <ToolTraffic />
        </aside>
        <CenterStage />
        <aside className="flex min-h-0 flex-col gap-3 min-[1700px]:gap-4">
          <Approval />
          <Conversation />
          <Evidence />
        </aside>
      </main>
      <Timeline />
      <AgentPanel />
      <Drawer open={drawer} onClose={closeDrawer} />
      <Toaster position="bottom-center" offset={20} gap={8}
        toastOptions={{
          unstyled: false,
          style: { background: "var(--panel)", color: "var(--ink)", border: "1px solid var(--line-2)", borderRadius: 14, boxShadow: "var(--shadow-lift)", fontFamily: "var(--font-sans)", fontSize: 14 },
          classNames: { description: "!text-[var(--ink-2)] !text-[13px]", title: "!font-semibold" },
        }} />
    </div>
  );
}
