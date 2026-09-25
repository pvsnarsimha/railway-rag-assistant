import React, { useEffect } from "react";
import { StatusBar } from "expo-status-bar";
import { NavigationContainer } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { SettingsProvider } from "./src/context/SettingsContext";
import { colors } from "./src/theme/colors";
import { configureForegroundNotificationHandler, addNotificationResponseListener, addNotificationReceivedListener, registerOfflineShell } from "./src/services/pushNotifications";
// Registers the headless "read notifications aloud" task at module scope.
import { registerReadAloudTask, speakPushData } from "./src/services/readAloudTask";
import { loadReadAloudAsync } from "./src/utils/speakNotifications";
import { Platform } from "react-native";

import ChatScreen from "./src/screens/ChatScreen";
import LiveTrackingScreen from "./src/screens/LiveTrackingScreen";
import MoreToolsScreen from "./src/screens/MoreToolsScreen";
import SettingsScreen from "./src/screens/SettingsScreen";
import HomeScreen from "./src/screens/HomeScreen";
import PnrStatusScreen from "./src/screens/PnrStatusScreen";
import LiveTrainStatusScreen from "./src/screens/LiveTrainStatusScreen";
import TrainScheduleScreen from "./src/screens/TrainScheduleScreen";
import SeatAvailabilityScreen from "./src/screens/SeatAvailabilityScreen";
import FareEnquiryScreen from "./src/screens/FareEnquiryScreen";
import TrainSearchScreen from "./src/screens/TrainSearchScreen";
import StationSearchScreen from "./src/screens/StationSearchScreen";

const Tab = createBottomTabNavigator();
const HomeStack = createNativeStackNavigator();

const TAB_ICONS = {
  Home: "home-outline",
  Chat: "chatbubble-ellipses-outline",
  Track: "navigate-circle-outline",
  More: "briefcase-outline",
  Settings: "settings-outline",
};

/**
 * REFORM: RailYatri-style "Train Enquiry Center" Home tab. HomeScreen is
 * the icon-grid landing tile; every tile it exposes (except "More" and
 * "Live GPS Tracking", which jump straight to their own existing tabs —
 * see HomeScreen.js's own comment on why) pushes one of these screens on
 * THIS tab's own stack, so the bottom tab bar and the other tabs' own
 * navigation stay completely untouched. "TrainsBetween" and "StationSearch"
 * reuse the existing TrainSearchScreen/StationSearchScreen components
 * (previously the standalone "Tools" tab's only two screens) rather than
 * duplicating their real search logic into second copies — see the removed
 * Tools tab below.
 */
function HomeStackNavigator() {
  return (
    <HomeStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.primary },
        headerTintColor: colors.textInverse,
        headerTitleStyle: { fontWeight: "700" },
      }}
    >
      <HomeStack.Screen name="Home" component={HomeScreen} options={{ title: "Train Enquiry Center" }} />
      <HomeStack.Screen name="LiveTrainStatus" component={LiveTrainStatusScreen} options={{ title: "Live Train Status" }} />
      <HomeStack.Screen name="PnrStatus" component={PnrStatusScreen} options={{ title: "PNR Status" }} />
      <HomeStack.Screen name="TrainSchedule" component={TrainScheduleScreen} options={{ title: "Time Table" }} />
      <HomeStack.Screen name="SeatAvailability" component={SeatAvailabilityScreen} options={{ title: "Seat Availability" }} />
      <HomeStack.Screen name="FareEnquiry" component={FareEnquiryScreen} options={{ title: "Fare Calculator" }} />
      <HomeStack.Screen name="TrainsBetween" component={TrainSearchScreen} options={{ title: "Trains Between Stations" }} />
      <HomeStack.Screen name="StationSearch" component={StationSearchScreen} options={{ title: "Station Search" }} />
    </HomeStack.Navigator>
  );
}

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
    registerOfflineShell();
    const unsubscribe = addNotificationResponseListener((response) => {
      const data = response?.notification?.request?.content?.data;
      if (data?.type === "delay_alert" || data?.type === "station_reached" || data?.type === "running_status") {
        console.log("[push] notification tapped:", data);
      }
    });
    // FEATURE: read train notifications aloud (native app). Open app: the
    // received listener speaks them; closed / background: the headless
    // task in src/services/readAloudTask.js does.
    let unsubscribeReceived = () => {};
    if (Platform.OS !== "web") {
      registerReadAloudTask();
      unsubscribeReceived = addNotificationReceivedListener(async (notification) => {
        const content = notification?.request?.content || {};
        if (!(await loadReadAloudAsync())) return;
        speakPushData({ ...(content.data || {}), title: content.title || content.data?.title, body: content.body || content.data?.body });
      });
    }
    return () => { unsubscribe(); unsubscribeReceived(); };
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
            <Tab.Screen name="Home" component={HomeStackNavigator} options={{ title: "Home", headerShown: false }} />
            <Tab.Screen name="Chat" component={ChatScreen} options={{ title: "Railway Assistant" }} />
            <Tab.Screen name="Track" component={LiveTrackingScreen} options={{ title: "Live Tracking" }} />
            <Tab.Screen name="More" component={MoreToolsScreen} options={{ title: "More Tools" }} />
            <Tab.Screen name="Settings" component={SettingsScreen} options={{ title: "Settings" }} />
          </Tab.Navigator>
        </NavigationContainer>
      </SettingsProvider>
    </SafeAreaProvider>
  );
}
