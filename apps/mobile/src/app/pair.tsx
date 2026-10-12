import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useAway } from "../away";
import { Button } from "../components/ui";
import { mono, useTheme } from "../theme";

export default function PairScreen() {
  const theme = useTheme();
  const { device, pair } = useAway();
  const [permission, requestPermission] = useCameraPermissions();
  const [offer, setOffer] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const pairing = useRef(false);

  // Close as soon as this phone is paired, however pairing happened.
  useEffect(() => {
    if (!device?.laptop) return;
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }, [device?.laptop]);

  async function submit(text: string) {
    if (pairing.current || !text.trim()) return;
    pairing.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await pair(text);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (pairError) {
      setError((pairError as Error).message);
    } finally {
      pairing.current = false;
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[styles.title, { color: theme.text }]}>Connect to your laptop</Text>
        <Text style={[styles.body, { color: theme.secondary }]}>Open Away on your laptop, choose “Pair a phone”, and scan the code.</Text>

        <View style={[styles.camera, { backgroundColor: theme.surface }]}>
          {permission?.granted ? (
            <CameraView style={StyleSheet.absoluteFill} barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={busy ? undefined : (result) => void submit(result.data)} />
          ) : (
            <View style={styles.permission}>
              <Text style={[styles.body, { color: theme.secondary, textAlign: "center" }]}>Camera access is used only to read the pairing code.</Text>
              <Button title="Allow camera" variant="secondary" onPress={() => void requestPermission()} />
            </View>
          )}
        </View>

        <Text style={[styles.label, { color: theme.secondary }]}>Or paste the pairing link</Text>
        <TextInput
          value={offer}
          onChangeText={setOffer}
          placeholder="away://pair?…"
          placeholderTextColor={theme.tertiary}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          style={[styles.input, { color: theme.text, backgroundColor: theme.surface }]}
        />
        <Button title="Pair" onPress={() => void submit(offer)} disabled={!offer.trim()} loading={busy} />
        {error && <Text style={[styles.body, { color: theme.red, textAlign: "center" }]}>{error}</Text>}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 14 },
  title: { fontSize: 22, fontWeight: "700", marginTop: 8 },
  body: { fontSize: 15, lineHeight: 21 },
  camera: { aspectRatio: 1, borderRadius: 20, overflow: "hidden", marginVertical: 8 },
  permission: { flex: 1, alignItems: "center", justifyContent: "center", gap: 14, padding: 24 },
  label: { fontSize: 13, fontWeight: "500" },
  input: { minHeight: 70, borderRadius: 14, padding: 12, fontFamily: mono, fontSize: 12 },
});
