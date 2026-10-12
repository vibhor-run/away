// One shared connection to the paired laptop for the whole app.
import { AwayClient, pairWithLaptop, type ConnectionState, type TrackedCommand } from "@away/client";
import type { AgentInfo, Project, SessionSummary } from "@away/protocol";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Platform } from "react-native";
import { loadDeviceState, saveDeviceState, type DeviceState } from "./storage";

interface AwayContextValue {
  ready: boolean;
  device: DeviceState | undefined;
  client: AwayClient | undefined;
  connection: { state: ConnectionState; detail?: string };
  projects: Project[];
  agents: AgentInfo[];
  sessions: SessionSummary[];
  commands: Record<string, TrackedCommand>;
  pair(offer: string): Promise<void>;
  forget(): Promise<void>;
  refresh(): Promise<void>;
}

const AwayContext = createContext<AwayContextValue | undefined>(undefined);

export function AwayProvider({ children }: { children: ReactNode }) {
  const [device, setDevice] = useState<DeviceState>();
  const [ready, setReady] = useState(false);
  const [connection, setConnection] = useState<AwayContextValue["connection"]>({ state: "stopped" });
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [commands, setCommands] = useState<Record<string, TrackedCommand>>({});
  const clientRef = useRef<AwayClient>(undefined);

  useEffect(() => {
    void loadDeviceState().then((state) => {
      setDevice(state);
      setReady(true);
    });
  }, []);

  const client = useMemo(() => (device?.laptop ? new AwayClient(device.laptop, device.keys) : undefined), [device]);
  clientRef.current = client;

  const refresh = useCallback(async () => {
    const current = clientRef.current;
    if (!current || current.state !== "connected") return;
    const [nextProjects, nextAgents, nextSessions] = await Promise.all([
      current.request<Project[]>({ kind: "list_projects" }),
      current.request<AgentInfo[]>({ kind: "list_agents" }),
      current.request<SessionSummary[]>({ kind: "list_sessions" }),
    ]);
    setProjects(nextProjects);
    setAgents(nextAgents);
    setSessions(nextSessions);
  }, []);

  useEffect(() => {
    if (!client) return;
    client.listeners.state.add((state, detail) => {
      setConnection({ state, ...(detail !== undefined && { detail }) });
      if (state === "connected") void refresh().catch(() => {});
    });
    client.listeners.command.add((command) => setCommands((current) => ({ ...current, [command.commandId]: command })));
    client.listeners.sessionUpdated.add((session) =>
      setSessions((current) => [session, ...current.filter((entry) => entry.id !== session.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt))),
    );
    client.start();
    return () => client.stop();
  }, [client, refresh]);

  const value: AwayContextValue = {
    ready,
    device,
    client,
    connection,
    projects,
    agents,
    sessions,
    commands,
    refresh,
    async pair(offer) {
      if (!device) return;
      const laptop = await pairWithLaptop(offer, Platform.OS === "ios" ? "iPhone" : "Android phone", device.keys);
      const next = { ...device, laptop };
      await saveDeviceState(next);
      setDevice(next);
    },
    async forget() {
      if (!device) return;
      const next = { keys: device.keys };
      await saveDeviceState(next);
      setDevice(next);
      setProjects([]);
      setSessions([]);
    },
  };

  return <AwayContext.Provider value={value}>{children}</AwayContext.Provider>;
}

export function useAway(): AwayContextValue {
  const value = useContext(AwayContext);
  if (!value) throw new Error("useAway must be used inside AwayProvider");
  return value;
}
