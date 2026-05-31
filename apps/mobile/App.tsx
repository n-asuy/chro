import { useMemo, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { getChroNative } from "./src/native/chro-native";

const native = getChroNative();

function AppContent() {
  const isDarkMode = useColorScheme() === "dark";
  const [message, setMessage] = useState("mobile ready");
  const response = useMemo(() => native.echo(message), [message]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle={isDarkMode ? "light-content" : "dark-content"} />
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.header}>
          <Text style={styles.eyebrow}>Chro Mobile</Text>
          <Text style={styles.title}>React Native + Rust</Text>
          <Text style={styles.subtitle}>
            Bare React Native shell with a Rust native crate ready for the
            platform bridge.
          </Text>
        </View>

        <View style={styles.panel}>
          <Text style={styles.label}>Native module</Text>
          <Text style={styles.value}>
            {native.isLinked ? "linked" : "fallback"}
          </Text>
        </View>

        <View style={styles.panel}>
          <Text style={styles.label}>Rust crate</Text>
          <Text style={styles.value}>{native.getVersion()}</Text>
        </View>

        <View style={styles.panel}>
          <Text style={styles.label}>Echo boundary</Text>
          <Text style={styles.value}>{response}</Text>
          <View style={styles.actions}>
            {["mobile ready", Platform.OS, "rust boundary"].map(
              (nextMessage) => (
                <Pressable
                  accessibilityRole="button"
                  key={nextMessage}
                  onPress={() => setMessage(nextMessage)}
                  style={({ pressed }) => [
                    styles.action,
                    pressed ? styles.actionPressed : undefined,
                  ]}
                >
                  <Text style={styles.actionText}>{nextMessage}</Text>
                </Pressable>
              ),
            )}
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#101418",
  },
  container: {
    flexGrow: 1,
    gap: 16,
    padding: 24,
  },
  header: {
    gap: 8,
    paddingVertical: 20,
  },
  eyebrow: {
    color: "#93C5FD",
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0,
    textTransform: "uppercase",
  },
  title: {
    color: "#F8FAFC",
    fontSize: 36,
    fontWeight: "800",
    letterSpacing: 0,
    lineHeight: 42,
  },
  subtitle: {
    color: "#CBD5E1",
    fontSize: 16,
    lineHeight: 24,
    maxWidth: 420,
  },
  panel: {
    backgroundColor: "#18212B",
    borderColor: "#2C3948",
    borderRadius: 8,
    borderWidth: 1,
    gap: 8,
    padding: 16,
  },
  label: {
    color: "#94A3B8",
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0,
    textTransform: "uppercase",
  },
  value: {
    color: "#F8FAFC",
    fontSize: 20,
    fontWeight: "700",
    letterSpacing: 0,
    lineHeight: 28,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingTop: 8,
  },
  action: {
    alignItems: "center",
    backgroundColor: "#2563EB",
    borderRadius: 6,
    justifyContent: "center",
    minHeight: 40,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  actionPressed: {
    backgroundColor: "#1D4ED8",
  },
  actionText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: 0,
  },
});
