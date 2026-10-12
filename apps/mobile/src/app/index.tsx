import { Redirect, router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useAway } from "../away";
import { Button, Dot, Icon, Row, SectionTitle } from "../components/ui";
import { AGENT_NAMES, statusColor, useTheme } from "../theme";

export default function HomeScreen() {
  const theme = useTheme();
  const { ready, device, client, connection, projects, agents, sessions, refresh, forget } = useAway();
  const [refreshing, setRefreshing] = useState(false);
  const [starting, setStarting] = useState(false);

  if (!ready) return <ActivityIndicator style={{ flex: 1 }} />;
  if (!device?.laptop) return <Redirect href="/pair" />;

  const status = {
    connected: "Connected",
    connecting: "Connecting…",
    disconnected: connection.detail ?? "Reconnecting…",
    rejected: connection.detail ?? "This phone is no longer paired",
    stopped: "Not connected",
  }[connection.state];
  const installed = agents.filter((agent) => agent.installed);

  function chooseAgent(projectId: string, projectName: string) {
    if (installed.length === 0) return Alert.alert("No agents", "No supported agents are installed on your laptop.");
    Alert.alert(projectName, "Start a new chat with", [
      ...installed.map((agent) => ({ text: agent.displayName, onPress: () => void start(projectId, agent.id) })),
      { text: "Cancel", style: "cancel" as const },
    ]);
  }

  async function start(projectId: string, agent: string) {
    if (!client) return;
    setStarting(true);
    try {
      const session = await client.request<{ id: string }>({ kind: "start_session", agent, projectId });
      router.push({ pathname: "/session/[id]", params: { id: session.id } });
    } catch (startError) {
      Alert.alert("Could not start", (startError as Error).message);
    } finally {
      setStarting(false);
    }
  }

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: 40 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await refresh().catch(() => {});
            setRefreshing(false);
          }}
        />
      }
    >
      <View style={[styles.laptop, { backgroundColor: theme.surface }]}>
        <Icon name="laptopcomputer" size={22} color={theme.text} fallback="⌨" />
        <View style={{ flex: 1 }}>
          <Text style={[styles.laptopName, { color: theme.text }]} numberOfLines={1}>
            {device.laptop.laptopName.replace(/\.local$/, "")}
          </Text>
          <View style={styles.statusLine}>
            <Dot color={statusColor(theme, connection.state)} />
            <Text style={{ color: theme.secondary, fontSize: 13 }}>{status}</Text>
          </View>
        </View>
        {starting && <ActivityIndicator />}
      </View>
      {connection.state === "rejected" && (
        <Button title="Pair again" variant="secondary" style={{ marginHorizontal: 16, marginTop: 12 }} onPress={() => void forget().then(() => router.push("/pair"))} />
      )}

      <SectionTitle>Projects</SectionTitle>
      {projects.length === 0 && (
        <Text style={[styles.empty, { color: theme.tertiary }]}>
          {connection.state === "connected" ? "Add a project folder in Away on your laptop." : "Projects appear once connected."}
        </Text>
      )}
      {projects.map((project) => (
        <Row
          key={project.id}
          title={project.name}
          subtitle={project.path.replace(/^\/Users\/[^/]+/, "~")}
          left={<Icon name="folder" size={18} color={theme.secondary} fallback="▣" />}
          right={<Icon name="plus" size={15} color={theme.tertiary} fallback="+" />}
          onPress={() => chooseAgent(project.id, project.name)}
        />
      ))}

      <SectionTitle>Chats</SectionTitle>
      {sessions.length === 0 && <Text style={[styles.empty, { color: theme.tertiary }]}>Tap a project to start a chat with an agent.</Text>}
      {sessions.map((session) => (
        <Row
          key={session.id}
          title={`${AGENT_NAMES[session.agent] ?? session.agent} · ${session.projectName}`}
          subtitle={{ running: "Working…", idle: "Ready", starting: "Starting…", ended: "Ended" }[session.status]}
          left={<Dot color={statusColor(theme, session.status)} />}
          right={<Icon name="chevron.right" size={12} color={theme.tertiary} fallback="›" />}
          onPress={() => router.push({ pathname: "/session/[id]", params: { id: session.id } })}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  laptop: { flexDirection: "row", alignItems: "center", gap: 14, marginHorizontal: 16, marginTop: 8, padding: 16, borderRadius: 16 },
  laptopName: { fontSize: 16, fontWeight: "600" },
  statusLine: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 3 },
  empty: { fontSize: 14, paddingHorizontal: 16, paddingVertical: 8 },
});
