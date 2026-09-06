import React, { useEffect } from "react";
import { StatusBar } from "expo-status-bar";
import { NavigationContainer } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { SettingsProvider } from "./src/context/SettingsContext";
import { colors } from "./src/theme/colors";
import { configureForegroundNotificationHandler, addNotificationResponseListener } from "./src/services/pushNotifications";

import ChatScreen from "./src/screens/ChatScreen";
import LiveTrackingScreen from "./src/screens/LiveTrackingScreen";
import ToolsScreen from "./src/screens/ToolsScreen";
import MoreToolsScreen from "./src/screens/MoreToolsScreen";
import AnalyticsScreen from "./src/screens/AnalyticsScreen";
import SettingsScreen from "./src/screens/SettingsScreen";

const Tab = createBottomTabNavigator();

const TAB_ICONS = {
  Chat: "chatbubble-ellipses-outline",
  Track: "navigate-circle-outline",
  Tools: "construct-outline",
  More: "briefcase-outline",
  Analytics: "bar-chart-outline",
  Settings: "settings-outline",
};

export default function App() {
  // Background/foreground push notifications for watched-train delay
  // alerts (see src/services/pushNotifications.js + the "Enable
  // Background Push" button on the Delay Alerts tool in More Tools).
  // Configuring the foreground handler here — once, at app startup —
  // is what makes a push that arrives while the app is open and focused
  // actually show a banner instead of being silently swallowed; the
  // response listener lets a tap on a delivered notification be observed
  // even though this app doesn't yet deep-link into a specific train's
  // tracking screen from it.
  useEffect(() => {
    configureForegroundNotificationHandler();
    const unsubscribe = addNotificationResponseListener((response) => {
      const data = response?.notification?.request?.content?.data;
      if (data?.type === "delay_alert" || data?.type === "station_reached") {
        console.log("[push] notification tapped:", data);
      }
    });
    return unsubscribe;
  }, []);

  return (
    <SafeAreaProvider>
      <SettingsProvider>
        <NavigationContainer>
          <StatusBar style="light" />
          <Tab.Navigator
            screenOptions={({ route }) => ({
              headerStyle: { backgroundColor: colors.primary },
              headerTintColor: colors.textInverse,
              headerTitleStyle: { fontWeight: "700" },
              tabBarActiveTintColor: colors.primary,
              tabBarInactiveTintColor: colors.textMuted,
              tabBarIcon: ({ color, size }) => (
                <Ionicons name={TAB_ICONS[route.name]} size={size} color={color} />
              ),
            })}
          >
            <Tab.Screen name="Chat" component={ChatScreen} options={{ title: "Railway Assistant" }} />
            <Tab.Screen name="Track" component={LiveTrackingScreen} options={{ title: "Live Tracking" }} />
            <Tab.Screen name="Tools" component={ToolsScreen} options={{ title: "Tools" }} />
            <Tab.Screen name="More" component={MoreToolsScreen} options={{ title: "More Tools" }} />
            <Tab.Screen name="Analytics" component={AnalyticsScreen} options={{ title: "Analytics & Feedback" }} />
            <Tab.Screen name="Settings" component={SettingsScreen} options={{ title: "Settings" }} />
          </Tab.Navigator>
        </NavigationContainer>
      </SettingsProvider>
    </SafeAreaProvider>
  );
}
