import type { Project } from "@away/protocol";
import { useCallback, useEffect, useState } from "react";
import type { Device, SessionInfo, Status } from "../shared/api";

export interface AwayData {
  status: Status | undefined;
  projects: Project[];
  devices: Device[];
  sessions: SessionInfo[];
  refresh: () => Promise<void>;
}

/** Live data from the companion: status is pushed, lists are refreshed every 2 seconds. */
export function useAway(): AwayData {
  const [status, setStatus] = useState<Status>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);

  const refresh = useCallback(async () => {
    const [nextProjects, nextDevices, nextSessions] = await Promise.all([
      window.away.listProjects(),
      window.away.listDevices(),
      window.away.listSessions(),
    ]);
    setProjects(nextProjects);
    setDevices(nextDevices);
    setSessions(nextSessions);
  }, []);

  useEffect(() => {
    void window.away.getStatus().then(setStatus);
    const unsubscribe = window.away.onStatus(setStatus);
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [refresh]);

  return { status, projects, devices, sessions, refresh };
}
