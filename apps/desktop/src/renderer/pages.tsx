import type { Project } from "@away/protocol";
import { Activity, FolderOpen, FolderPlus, QrCode, Smartphone, Trash2 } from "lucide-react";
import { useState } from "react";
import type { Device, SessionInfo, Status } from "../shared/api";
import { Button, EmptyState, PageHeader, Row, StatusDot, timeAgo } from "./components/ui";

const AGENT_NAMES: Record<string, string> = { pi: "Pi", claude: "Claude Code", codex: "Codex" };

export function Overview({
  status,
  projects,
  devices,
  sessions,
  onPair,
  onAddProject,
}: {
  status: Status | undefined;
  projects: Project[];
  devices: Device[];
  sessions: SessionInfo[];
  onPair: () => void;
  onAddProject: () => void;
}) {
  const state = status?.relay.state ?? "connecting";
  const headline = { online: "Remote access is on", connecting: "Connecting…", offline: "Offline" }[state];
  const detail =
    state === "online"
      ? "Paired phones can reach this Mac. Keep it awake and connected."
      : state === "connecting"
        ? "Reaching the relay."
        : `Retrying automatically${status?.relay.detail ? ` (${status.relay.detail})` : ""}.`;
  const activeDevices = devices.filter((device) => !device.revokedAt).length;
  const liveSessions = sessions.filter((session) => session.status !== "ended").length;

  return (
    <>
      <PageHeader title="Overview" />
      <div className="animate-fade-in space-y-6 p-6">
        <section className="rounded-2xl bg-gradient-to-br from-neutral-50 to-white p-5 ring-1 ring-black/5 dark:from-white/[0.06] dark:to-white/[0.02] dark:ring-white/10">
          <div className="flex items-center gap-2.5">
            <StatusDot state={state} />
            <h2 className="text-lg font-semibold tracking-tight">{headline}</h2>
          </div>
          <p className="mt-1 text-[13px] text-neutral-500">{detail}</p>
          <p className="selectable mt-3 font-mono text-[11px] text-neutral-400">
            {status?.laptopName} · {status?.relayUrl}
          </p>
          <div className="mt-5 flex gap-2">
            <Button variant="primary" onClick={onPair}>
              <QrCode size={14} /> Pair a phone
            </Button>
            <Button onClick={onAddProject}>
              <FolderPlus size={14} /> Add project
            </Button>
          </div>
        </section>

        <section className="grid grid-cols-3 gap-3">
          <Stat label="Projects" value={projects.length} />
          <Stat label="Paired devices" value={activeDevices} />
          <Stat label="Live sessions" value={liveSessions} />
        </section>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl p-4 ring-1 ring-black/5 dark:ring-white/10">
      <div className="text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      <div className="mt-0.5 text-xs text-neutral-500">{label}</div>
    </div>
  );
}

export function Projects({ projects, onAdd, onChanged }: { projects: Project[]; onAdd: () => void; onChanged: () => void }) {
  const [error, setError] = useState<string>();
  return (
    <>
      <PageHeader
        title="Projects"
        subtitle="Phones can only start agents in these folders."
        action={
          <Button variant="primary" onClick={onAdd}>
            <FolderPlus size={14} /> Add folder
          </Button>
        }
      />
      {error && <p className="px-6 pt-3 text-xs text-red-500">{error}</p>}
      {projects.length === 0 ? (
        <EmptyState
          icon={<FolderOpen size={20} />}
          title="No projects yet"
          body="Add a folder to let your paired phones start Claude Code, Codex, or Pi in it."
          action={<Button onClick={onAdd}>Add folder</Button>}
        />
      ) : (
        <div className="animate-fade-in p-3">
          {projects.map((project) => (
            <Row
              key={project.id}
              icon={<FolderOpen size={15} />}
              title={project.name}
              subtitle={<span className="selectable font-mono text-[11px]">{project.path}</span>}
              trailing={
                <Button
                  variant="danger"
                  className="opacity-0 group-hover:opacity-100"
                  onClick={async () => {
                    setError(undefined);
                    try {
                      await window.away.removeProject(project.id);
                      onChanged();
                    } catch (removeError) {
                      setError((removeError as Error).message);
                    }
                  }}
                  aria-label={`Remove ${project.name}`}
                >
                  <Trash2 size={13} />
                </Button>
              }
            />
          ))}
        </div>
      )}
    </>
  );
}

export function Devices({ devices, onPair, onChanged }: { devices: Device[]; onPair: () => void; onChanged: () => void }) {
  const [confirming, setConfirming] = useState<string>();
  return (
    <>
      <PageHeader
        title="Devices"
        subtitle="Phones that can control agents on this Mac."
        action={
          <Button variant="primary" onClick={onPair}>
            <QrCode size={14} /> Pair a phone
          </Button>
        }
      />
      {devices.length === 0 ? (
        <EmptyState
          icon={<Smartphone size={20} />}
          title="No paired devices"
          body="Scan a pairing code with the Away app to control your agents from anywhere."
          action={<Button onClick={onPair}>Show pairing code</Button>}
        />
      ) : (
        <div className="animate-fade-in p-3">
          {devices.map((device) => (
            <Row
              key={device.id}
              icon={<Smartphone size={15} />}
              title={<span className={device.revokedAt ? "text-neutral-400 line-through" : ""}>{device.name}</span>}
              subtitle={device.revokedAt ? `Revoked ${timeAgo(device.revokedAt)}` : `Paired ${timeAgo(device.pairedAt)}`}
              trailing={
                !device.revokedAt &&
                (confirming === device.id ? (
                  <>
                    <Button variant="ghost" onClick={() => setConfirming(undefined)}>
                      Cancel
                    </Button>
                    <Button
                      variant="danger"
                      onClick={async () => {
                        await window.away.revokeDevice(device.id);
                        setConfirming(undefined);
                        onChanged();
                      }}
                    >
                      Revoke access
                    </Button>
                  </>
                ) : (
                  <Button variant="ghost" className="opacity-0 group-hover:opacity-100" onClick={() => setConfirming(device.id)}>
                    Revoke
                  </Button>
                ))
              }
            />
          ))}
        </div>
      )}
    </>
  );
}

export function Sessions({ sessions, projects }: { sessions: SessionInfo[]; projects: Project[] }) {
  const projectName = (id: string) => projects.find((project) => project.id === id)?.name ?? "Unknown project";
  return (
    <>
      <PageHeader title="Sessions" subtitle="Agent sessions started from your devices." />
      {sessions.length === 0 ? (
        <EmptyState icon={<Activity size={20} />} title="No sessions yet" body="Sessions appear here when you start an agent from your phone." />
      ) : (
        <div className="animate-fade-in p-3">
          {sessions.map((session) => (
            <Row
              key={session.id}
              icon={<span className="text-[11px] font-semibold">{(AGENT_NAMES[session.agent] ?? session.agent).slice(0, 2)}</span>}
              title={`${AGENT_NAMES[session.agent] ?? session.agent} · ${projectName(session.projectId)}`}
              subtitle={`Started ${timeAgo(session.createdAt)}`}
              trailing={
                <span className="flex items-center gap-1.5 text-xs capitalize text-neutral-500">
                  <StatusDot state={session.status} /> {session.status}
                </span>
              }
            />
          ))}
        </div>
      )}
    </>
  );
}
