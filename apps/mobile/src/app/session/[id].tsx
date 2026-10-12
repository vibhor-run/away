import type { SessionEventMessage } from "@away/client";
import type { InputResponse, Question, SessionEvent } from "@away/protocol";
import * as Haptics from "expo-haptics";
import { Stack, useLocalSearchParams } from "expo-router";
import { memo, useEffect, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Animated, { FadeIn, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAway } from "../../away";
import { Button, Icon } from "../../components/ui";
import { AGENT_NAMES, mono, useTheme, type Theme } from "../../theme";

type InputRequest = Extract<SessionEvent, { type: "input_requested" }>;

type Item =
  | { kind: "user"; key: string; text: string; commandId: string }
  | { kind: "assistant"; key: string; text: string }
  | { kind: "tool"; key: string; name: string; args: unknown; output?: string; isError?: boolean }
  | { kind: "notice"; key: string; text: string; error: boolean }
  | { kind: "request"; key: string; request: InputRequest; resolved: boolean };

/** Applies one session event to the visible list. Pure, so a batch is applied in one update. */
function apply(items: Item[], { seq, event }: SessionEventMessage): Item[] {
  const replace = (key: string, update: (item: Item) => Item) => items.map((item) => (item.key === key ? update(item) : item));
  const has = (key: string) => items.some((item) => item.key === key);
  switch (event.type) {
    case "prompt_sent":
      return [...items, { kind: "user", key: `user-${seq}`, text: event.text, commandId: event.commandId }];
    case "text_delta": {
      const key = `msg-${event.messageId}`;
      if (has(key)) return replace(key, (item) => (item.kind === "assistant" ? { ...item, text: item.text + event.delta } : item));
      return [...items, { kind: "assistant", key, text: event.delta }];
    }
    case "message_completed": {
      if (event.role !== "assistant") return items;
      const key = `msg-${event.messageId}`;
      const text = event.errorMessage ? `${event.text}\n\n${event.errorMessage}`.trim() : event.text;
      if (has(key)) return replace(key, (item) => (item.kind === "assistant" ? { ...item, text } : item));
      return text ? [...items, { kind: "assistant", key, text }] : items;
    }
    case "tool_started":
      return [...items, { kind: "tool", key: `tool-${event.toolCallId}`, name: event.toolName, args: event.args }];
    case "tool_updated":
    case "tool_finished": {
      const key = `tool-${event.toolCallId}`;
      const isError = event.type === "tool_finished" ? event.isError : undefined;
      if (!has(key)) return [...items, { kind: "tool", key, name: "tool", args: {}, output: event.output, ...(isError !== undefined && { isError }) }];
      return replace(key, (item) => (item.kind === "tool" ? { ...item, output: event.output, ...(isError !== undefined && { isError }) } : item));
    }
    case "input_requested":
      return [...items, { kind: "request", key: `req-${event.requestId}`, request: event, resolved: false }];
    case "input_resolved":
      return replace(`req-${event.requestId}`, (item) => (item.kind === "request" ? { ...item, resolved: true } : item));
    case "notice":
      return [...items, { kind: "notice", key: `notice-${seq}`, text: event.message, error: event.level === "error" }];
    case "process_exited":
      return event.expected ? items : [...items, { kind: "notice", key: `exit-${seq}`, text: "The agent stopped unexpectedly.", error: true }];
    default:
      return items;
  }
}

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { client, sessions, commands, agents } = useAway();
  const session = sessions.find((entry) => entry.id === id);
  const agentName = AGENT_NAMES[session?.agent ?? ""] ?? session?.agent ?? "";
  const canResume = agents.find((agent) => agent.id === session?.agent)?.capabilities.resume ?? false;
  const [items, setItems] = useState<Item[]>([]);
  const [draft, setDraft] = useState("");
  const list = useRef<FlatList<Item>>(null);
  const atBottom = useRef(true);

  // Events are buffered and applied once per frame so fast streaming stays smooth.
  useEffect(() => {
    if (!client || !id) return;
    let buffer: SessionEventMessage[] = [];
    let frame: number | undefined;
    const flush = () => {
      frame = undefined;
      const batch = buffer;
      buffer = [];
      setItems((current) => batch.reduce(apply, current));
      if (batch.some((message) => message.event.type === "input_requested")) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    };
    const listener = (message: SessionEventMessage) => {
      if (message.sessionId !== id) return;
      buffer.push(message);
      frame ??= requestAnimationFrame(flush);
    };
    setItems([]);
    client.listeners.sessionEvent.add(listener);
    client.subscribe(id, 0);
    return () => {
      client.listeners.sessionEvent.delete(listener);
      client.unsubscribe(id);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [client, id]);

  const running = session?.status === "running" || session?.status === "starting";
  const ended = session?.status === "ended";
  const pending = [...items].reverse().find((item): item is Extract<Item, { kind: "request" }> => item.kind === "request" && !item.resolved);
  const showThinking = running && !pending && items.at(-1)?.kind !== "assistant";

  function send() {
    const text = draft.trim();
    if (!client || !text || !id) return;
    client.send({ kind: "send_prompt", sessionId: id, text });
    setDraft("");
    atBottom.current = true;
  }

  async function respond(requestId: string, response: InputResponse) {
    if (!client || !id) return;
    setItems((current) => current.map((item) => (item.key === `req-${requestId}` && item.kind === "request" ? { ...item, resolved: true } : item)));
    await client.request({ kind: "respond_input", sessionId: id, requestId, response }).catch(() => {});
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: theme.background }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={Platform.OS === "ios" ? insets.top + 44 : 0}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={{ alignItems: "center" }}>
              <Text style={{ color: theme.text, fontSize: 16, fontWeight: "600" }}>{agentName}</Text>
              <Text style={{ color: theme.secondary, fontSize: 12 }}>{session?.projectName}</Text>
            </View>
          ),
        }}
      />
      <FlatList
        ref={list}
        data={items}
        keyExtractor={(item) => item.key}
        contentContainerStyle={styles.list}
        keyboardDismissMode="interactive"
        onScroll={({ nativeEvent }) => {
          atBottom.current = nativeEvent.contentSize.height - nativeEvent.layoutMeasurement.height - nativeEvent.contentOffset.y < 120;
        }}
        scrollEventThrottle={64}
        onContentSizeChange={() => atBottom.current && list.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={[styles.emptyTitle, { color: theme.text }]}>What should {agentName || "the agent"} do?</Text>
            <Text style={{ color: theme.secondary, fontSize: 14, textAlign: "center" }}>It runs on your laptop in {session?.projectName ?? "this project"}.</Text>
          </View>
        }
        ListFooterComponent={showThinking ? <Thinking theme={theme} /> : null}
        renderItem={({ item }) => <ItemView item={item} theme={theme} status={item.kind === "user" ? commands[item.commandId]?.status : undefined} />}
      />

      {pending && <RequestCard request={pending.request} theme={theme} onRespond={respond} />}

      <View style={[styles.composerArea, { paddingBottom: Math.max(insets.bottom, 10) }]}>
        {ended ? (
          <Button title="Resume chat" variant="secondary" disabled={!canResume} onPress={() => void client?.request({ kind: "resume_session", sessionId: id }).catch(() => {})} />
        ) : (
          <View style={[styles.composer, { backgroundColor: theme.surface }]}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder={`Message ${agentName}`}
              placeholderTextColor={theme.tertiary}
              multiline
              style={[styles.input, { color: theme.text }]}
            />
            {running ? (
              <Pressable onPress={() => void client?.request({ kind: "interrupt", sessionId: id }).catch(() => {})} style={[styles.round, { backgroundColor: theme.primary }]} accessibilityLabel="Stop">
                <View style={[styles.stop, { backgroundColor: theme.onPrimary }]} />
              </Pressable>
            ) : (
              <Pressable onPress={send} disabled={!draft.trim()} style={[styles.round, { backgroundColor: draft.trim() ? theme.primary : theme.border }]} accessibilityLabel="Send">
                <Icon name="arrow.up" size={16} color={draft.trim() ? theme.onPrimary : theme.tertiary} fallback="↑" />
              </Pressable>
            )}
          </View>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const STATUS_LABEL: Record<string, string> = {
  submitted: "Sending…",
  received: "Received",
  accepted: "Working",
  failed: "Failed",
  interrupted: "Stopped",
};

const ItemView = memo(function ItemView({ item, theme, status }: { item: Item; theme: Theme; status: string | undefined }) {
  switch (item.kind) {
    case "user":
      return (
        <View style={styles.userWrap}>
          <View style={[styles.userBubble, { backgroundColor: theme.surface }]}>
            <Text style={[styles.text, { color: theme.text }]} selectable>
              {item.text}
            </Text>
          </View>
          {status && status !== "completed" && <Text style={[styles.caption, { color: status === "failed" ? theme.red : theme.tertiary }]}>{STATUS_LABEL[status]}</Text>}
        </View>
      );
    case "assistant":
      return (
        <Text style={[styles.text, { color: theme.text }]} selectable>
          {item.text}
        </Text>
      );
    case "tool":
      return <ToolRow item={item} theme={theme} />;
    case "notice":
      return <Text style={[styles.notice, { color: item.error ? theme.red : theme.secondary }]}>{item.text}</Text>;
    case "request":
      return item.resolved ? <Text style={[styles.notice, { color: theme.tertiary }]}>{item.request.title} · answered</Text> : null;
  }
});

/** One quiet line per tool call, like Codex. Tap to see the output. */
function ToolRow({ item, theme }: { item: Extract<Item, { kind: "tool" }>; theme: Theme }) {
  const [open, setOpen] = useState(false);
  const done = item.isError !== undefined;
  const verb = toolVerb(item.name, done);
  return (
    <View>
      <Pressable onPress={() => setOpen(!open)} style={styles.toolRow}>
        <Text style={[styles.toolText, { color: theme.secondary }]} numberOfLines={1}>
          {verb} <Text style={{ fontFamily: mono, color: item.isError ? theme.red : theme.text }}>{toolSummary(item.args) || item.name}</Text>
        </Text>
        <Icon name={open ? "chevron.up" : "chevron.down"} size={10} color={theme.tertiary} fallback="" />
      </Pressable>
      {open && (
        <View style={[styles.output, { backgroundColor: theme.surface }]}>
          <Text style={[styles.outputText, { color: theme.secondary }]} selectable>
            {item.output?.slice(-4000) || (done ? "No output" : "Running…")}
          </Text>
        </View>
      )}
    </View>
  );
}

/** Pulsing dot while the agent works and nothing is streaming yet. */
function Thinking({ theme }: { theme: Theme }) {
  const scale = useSharedValue(1);
  useEffect(() => {
    scale.value = withRepeat(withSequence(withTiming(1.35, { duration: 600 }), withTiming(1, { duration: 600 })), -1);
  }, []);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <Animated.View entering={FadeIn} style={{ paddingVertical: 8 }}>
      <Animated.View style={[{ width: 12, height: 12, borderRadius: 6, backgroundColor: theme.text }, style]} />
    </Animated.View>
  );
}

function RequestCard({ request, theme, onRespond }: { request: InputRequest; theme: Theme; onRespond: (requestId: string, response: InputResponse) => Promise<void> }) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const respond = (response: InputResponse) => void onRespond(request.requestId, response);
  return (
    <Animated.View entering={FadeIn.duration(150)} style={[styles.card, { backgroundColor: theme.background, borderColor: theme.border }]}>
      <Text style={[styles.cardTitle, { color: theme.text }]}>{request.title}</Text>
      {request.message ? <Text style={{ color: theme.secondary, fontSize: 14 }}>{request.message}</Text> : null}
      {request.tool && (
        <View style={[styles.code, { backgroundColor: theme.surface }]}>
          <Text style={[styles.outputText, { color: theme.text }]} numberOfLines={6}>
            {toolSummary(request.tool.input, 500) || request.tool.name}
          </Text>
        </View>
      )}

      {request.kind === "approval" && (
        <View style={styles.actions}>
          <Button title="Deny" variant="secondary" onPress={() => respond({ kind: "approval", decision: "deny" })} style={styles.action} />
          {request.allowAlways && <Button title="Always" variant="secondary" onPress={() => respond({ kind: "approval", decision: "allow_always" })} style={styles.action} />}
          <Button title="Allow" onPress={() => respond({ kind: "approval", decision: "allow" })} style={styles.action} />
        </View>
      )}

      {request.kind === "questions" && (
        <>
          {(request.questions ?? []).map((question: Question) => (
            <View key={question.id} style={{ gap: 8 }}>
              <Text style={{ color: theme.text, fontSize: 15, fontWeight: "500" }}>{question.question}</Text>
              <View style={styles.options}>
                {question.options.map((option) => {
                  const selected = answers[question.id]?.includes(option.label) ?? false;
                  return (
                    <Pressable
                      key={option.label}
                      onPress={() =>
                        setAnswers((current) => {
                          const previous = current[question.id] ?? [];
                          const next = question.multiSelect ? (selected ? previous.filter((label) => label !== option.label) : [...previous, option.label]) : [option.label];
                          return { ...current, [question.id]: next };
                        })
                      }
                      style={[styles.option, { borderColor: selected ? theme.primary : theme.border, backgroundColor: selected ? theme.primary : theme.background }]}
                    >
                      <Text style={{ color: selected ? theme.onPrimary : theme.text, fontSize: 14 }}>{option.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ))}
          <View style={styles.actions}>
            <Button title="Dismiss" variant="secondary" onPress={() => respond({ kind: "cancel" })} style={styles.action} />
            <Button title="Send" onPress={() => respond({ kind: "answers", answers })} style={styles.action} />
          </View>
        </>
      )}

      {request.kind === "confirm" && (
        <View style={styles.actions}>
          <Button title="No" variant="secondary" onPress={() => respond({ kind: "confirm", confirmed: false })} style={styles.action} />
          <Button title="Yes" onPress={() => respond({ kind: "confirm", confirmed: true })} style={styles.action} />
        </View>
      )}

      {(request.kind === "select" || request.kind === "input" || request.kind === "editor") && (
        <View style={styles.options}>
          {(request.options ?? []).map((option) => (
            <Pressable key={option} onPress={() => respond({ kind: "value", value: option })} style={[styles.option, { borderColor: theme.border }]}>
              <Text style={{ color: theme.text, fontSize: 14 }}>{option}</Text>
            </Pressable>
          ))}
          <Pressable onPress={() => respond({ kind: "cancel" })} style={[styles.option, { borderColor: theme.border }]}>
            <Text style={{ color: theme.secondary, fontSize: 14 }}>Dismiss</Text>
          </Pressable>
        </View>
      )}
    </Animated.View>
  );
}

function toolSummary(args: unknown, limit = 100): string {
  if (!args || typeof args !== "object") return "";
  const value = args as Record<string, unknown>;
  const first = value.command ?? value.file_path ?? value.path ?? value.pattern ?? value.url;
  return (typeof first === "string" ? first : JSON.stringify(args)).slice(0, limit);
}

function toolVerb(name: string, done: boolean): string {
  const lower = name.toLowerCase();
  if (lower.includes("bash") || lower.includes("command")) return done ? "Ran" : "Running";
  if (lower.includes("write") || lower.includes("edit") || lower.includes("file_change")) return done ? "Edited" : "Editing";
  if (lower.includes("read")) return done ? "Read" : "Reading";
  if (lower.includes("grep") || lower.includes("glob") || lower.includes("search")) return done ? "Searched" : "Searching";
  return done ? `Used ${name}` : `Using ${name}`;
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: 18, paddingTop: 12, paddingBottom: 16, gap: 16, flexGrow: 1 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 30 },
  emptyTitle: { fontSize: 22, fontWeight: "600", textAlign: "center" },
  text: { fontSize: 16, lineHeight: 24 },
  userWrap: { alignItems: "flex-end" },
  userBubble: { maxWidth: "85%", borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10 },
  caption: { fontSize: 11, marginTop: 4, marginRight: 6 },
  toolRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  toolText: { fontSize: 14, flexShrink: 1 },
  output: { borderRadius: 12, padding: 12, marginTop: 8 },
  outputText: { fontFamily: mono, fontSize: 12, lineHeight: 17 },
  notice: { fontSize: 13, textAlign: "center" },
  card: { marginHorizontal: 12, marginBottom: 8, padding: 16, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, gap: 10, shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 16, shadowOffset: { width: 0, height: 4 } },
  cardTitle: { fontSize: 16, fontWeight: "600" },
  code: { borderRadius: 12, padding: 12 },
  actions: { flexDirection: "row", gap: 8, marginTop: 4 },
  action: { flex: 1 },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  option: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 18, borderWidth: 1 },
  composerArea: { paddingHorizontal: 12, paddingTop: 6 },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 8, paddingLeft: 16, padding: 6, borderRadius: 26 },
  input: { flex: 1, minHeight: 38, maxHeight: 140, paddingTop: 9, paddingBottom: 9, fontSize: 16 },
  round: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  stop: { width: 12, height: 12, borderRadius: 2 },
});
