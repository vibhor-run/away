import { SymbolView, type SFSymbol } from "expo-symbols";
import type { ReactNode } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useTheme } from "../theme";

/** SF Symbol on iOS, a simple glyph elsewhere. */
export function Icon({ name, size = 16, color, fallback = "•" }: { name: string; size?: number; color?: string; fallback?: string }) {
  const theme = useTheme();
  const tint = color ?? theme.text;
  if (Platform.OS !== "ios") return <Text style={{ color: tint, fontSize: size }}>{fallback}</Text>;
  return <SymbolView name={name as SFSymbol} size={size} tintColor={tint} />;
}

export function Button({
  title,
  onPress,
  variant = "primary",
  disabled,
  loading,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const look = {
    primary: { background: theme.primary, text: theme.onPrimary, border: theme.primary },
    secondary: { background: theme.background, text: theme.text, border: theme.border },
    danger: { background: theme.background, text: theme.red, border: theme.border },
  }[variant];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [styles.button, { backgroundColor: look.background, borderColor: look.border, opacity: disabled ? 0.35 : pressed ? 0.75 : 1 }, style]}
    >
      {loading ? <ActivityIndicator color={look.text} /> : <Text style={[styles.buttonText, { color: look.text }]}>{title}</Text>}
    </Pressable>
  );
}

/** A tappable list row, like a settings or chat-list row. */
export function Row({ title, subtitle, left, right, onPress }: { title: string; subtitle?: string; left?: ReactNode; right?: ReactNode; onPress?: () => void }) {
  const theme = useTheme();
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, { backgroundColor: pressed ? theme.surface : "transparent" }]}>
      {left}
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowTitle, { color: theme.text }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[styles.rowSubtitle, { color: theme.secondary }]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
    </Pressable>
  );
}

export function Dot({ color }: { color: string }) {
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return <Text style={[styles.section, { color: theme.secondary }]}>{children}</Text>;
}

const styles = StyleSheet.create({
  button: { height: 44, borderRadius: 22, paddingHorizontal: 18, alignItems: "center", justifyContent: "center", borderWidth: StyleSheet.hairlineWidth },
  buttonText: { fontSize: 15, fontWeight: "600" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12 },
  rowTitle: { fontSize: 16 },
  rowSubtitle: { fontSize: 13, marginTop: 2 },
  section: { fontSize: 13, fontWeight: "500", paddingHorizontal: 16, marginTop: 24, marginBottom: 4 },
});
