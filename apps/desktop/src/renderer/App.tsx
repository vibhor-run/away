import { Activity, FolderOpen, LayoutGrid, Smartphone } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { PairSheet } from "./components/PairSheet";
import { StatusDot } from "./components/ui";
import { Devices, Overview, Projects, Sessions } from "./pages";
import { useAway } from "./useAway";

type Page = "overview" | "projects" | "devices" | "sessions";

const NAV: { page: Page; label: string; icon: ReactNode; shortcut: string }[] = [
  { page: "overview", label: "Overview", icon: <LayoutGrid size={15} />, shortcut: "1" },
  { page: "projects", label: "Projects", icon: <FolderOpen size={15} />, shortcut: "2" },
  { page: "devices", label: "Devices", icon: <Smartphone size={15} />, shortcut: "3" },
  { page: "sessions", label: "Sessions", icon: <Activity size={15} />, shortcut: "4" },
];

export function App() {
  const { status, projects, devices, sessions, refresh } = useAway();
  const [page, setPage] = useState<Page>("overview");
  const [pairing, setPairing] = useState(false);

  async function addProject() {
    const project = await window.away.addProject();
    if (project) {
      await refresh();
      setPage("projects");
    }
  }

  useEffect(() => {
    // The tray menu can ask the window to open the pairing sheet or a page.
    const unsubscribe = window.away.onNavigate((route) => {
      if (route === "pair") setPairing(true);
      else if (NAV.some((item) => item.page === route)) setPage(route as Page);
    });
    // ⌘1–⌘4 switch pages, ⌘P opens pairing.
    const onKey = (event: KeyboardEvent) => {
      if (!event.metaKey) return;
      const item = NAV.find((entry) => entry.shortcut === event.key);
      if (item) setPage(item.page);
      if (event.key === "p") setPairing(true);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      unsubscribe();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const relay = status?.relay.state ?? "connecting";

  return (
    <div className="flex h-full">
      {/* Sidebar: transparent, so the window's macOS vibrancy shows through. */}
      <aside className="flex w-[212px] shrink-0 flex-col">
        <div className="drag h-12 shrink-0" />
        <div className="px-4 pb-3 text-[15px] font-semibold tracking-tight">Away</div>
        <nav className="flex flex-col gap-0.5 px-2">
          {NAV.map((item) => (
            <button
              key={item.page}
              onClick={() => setPage(item.page)}
              className={`flex h-8 items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] transition-colors duration-150 ${
                page === item.page
                  ? "bg-black/[0.07] font-medium text-neutral-900 dark:bg-white/10 dark:text-white"
                  : "text-neutral-600 hover:bg-black/[0.04] dark:text-neutral-400 dark:hover:bg-white/5"
              }`}
            >
              <span className="opacity-80">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="mt-auto flex items-center gap-2 px-4 py-4 text-xs text-neutral-500">
          <StatusDot state={relay} />
          {{ online: "Online", connecting: "Connecting…", offline: "Offline" }[relay]}
        </div>
      </aside>

      {/* Content: an opaque panel beside the sidebar. */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden border-l border-black/5 bg-white dark:border-white/5 dark:bg-neutral-900">
        <div key={page} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {page === "overview" && (
            <Overview
              status={status}
              projects={projects}
              devices={devices}
              sessions={sessions}
              onPair={() => setPairing(true)}
              onAddProject={() => void addProject()}
            />
          )}
          {page === "projects" && <Projects projects={projects} onAdd={() => void addProject()} onChanged={() => void refresh()} />}
          {page === "devices" && <Devices devices={devices} onPair={() => setPairing(true)} onChanged={() => void refresh()} />}
          {page === "sessions" && <Sessions sessions={sessions} projects={projects} />}
        </div>
      </main>

      {pairing && (
        <PairSheet
          onClose={() => {
            setPairing(false);
            void refresh();
          }}
        />
      )}
    </div>
  );
}
