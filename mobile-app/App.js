import React, { useEffect } from "react";
import { StatusBar } from "expo-status-bar";
import { NavigationContainer } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
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
import HomeScreen from "./src/screens/HomeScreen";
import PnrStatusScreen from "./src/screens/PnrStatusScreen";
import LiveTrainStatusScreen from "./src/screens/LiveTrainStatusScreen";
import TrainScheduleScreen from "./src/screens/TrainScheduleScreen";
import SeatAvailabilityScreen from "./src/screens/SeatAvailabilityScreen";
import FareEnquiryScreen from "./src/screens/FareEnquiryScreen";
import TrainSearchScreen from "./src/screens/TrainSearchScreen";

const Tab = createBottomTabNavigator();
const HomeStack = createNativeStackNavigator();

const TAB_ICONS = {
  Home: "home-outline",
  Chat: "chatbubble-ellipses-outline",
  Track: "navigate-circle-outline",
  Tools: "construct-outline",
  More: "briefcase-outline",
  Analytics: "bar-chart-outline",
  Settings: "settings-outline",
};

/**
 * FEATURE: RailYatri-style "Train Enquiry Center" Home tab. HomeScreen is
 * the icon-grid landing tile; every tile it exposes (except "More" and
 * "Live GPS Tracking", which jump straight to their own existing tabs —
 * see HomeScreen.js's own comment on why) pushes one of these screens on
 * THIS tab's own stack, so the bottom tab bar and the other tabs' own
 * navigation stay completely untouched. "TrainsBetween" reuses the
 * existing TrainSearchScreen (already built and working inside the Tools
 * tab) rather than duplicating ~330 lines of real search/booking-handoff
 * logic into a second copy.
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
            <Tab.Screen name="Home" component={HomeStackNavigator} options={{ title: "Home", headerShown: false }} />
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
