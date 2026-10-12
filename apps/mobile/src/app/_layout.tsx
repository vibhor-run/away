import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AwayProvider } from "../away";
import { Autotest } from "../autotest";
import { useTheme } from "../theme";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AwayProvider>
        <Navigator />
        <Autotest />
      </AwayProvider>
    </SafeAreaProvider>
  );
}

function Navigator() {
  const theme = useTheme();
  return (
    <>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerShadowVisible: false,
          headerStyle: { backgroundColor: theme.background },
          headerTintColor: theme.text,
          headerTitleStyle: { fontSize: 17, fontWeight: "600" },
          headerBackButtonDisplayMode: "minimal",
          contentStyle: { backgroundColor: theme.background },
        }}
      >
        <Stack.Screen name="index" options={{ title: "Away" }} />
        <Stack.Screen name="pair" options={{ title: "Pair", presentation: "modal" }} />
        <Stack.Screen name="session/[id]" options={{ title: "" }} />
      </Stack>
    </>
  );
}
