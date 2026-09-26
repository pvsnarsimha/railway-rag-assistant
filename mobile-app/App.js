import React, { useEffect } from "react";
import { StatusBar } from "expo-status-bar";
import { NavigationContainer } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { SettingsProvider } from "./src/context/SettingsContext";
import { LanguageProvider, useT } from "./src/context/LanguageContext";
import { colors } from "./src/theme/colors";
import { View } from "react-native";
import { SpeakScope } from "./src/i18n/Localized";
import ScreenLanguageBar from "./src/components/ScreenLanguageBar";
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

/**
 * FEATURE: every screen in the chosen language + "Speak screen".
 * Each screen gets its own SpeakScope (what it shows can be read aloud).
 * Screens that already place the 🌐 / 🔊 bar themselves (Home, Railway
 * Assistant, Live Tracking) are only wrapped; the rest get the bar on top.
 */
function withScreenLanguage(Screen, { bar = true } = {}) {
  function Localized(props) {
    return (
      <SpeakScope>
        {bar ? (
          <View style={{ flex: 1, backgroundColor: colors.bg }}>
            <ScreenLanguageBar style={{ paddingHorizontal: 12, paddingTop: 8, marginBottom: 0 }} />
            <View style={{ flex: 1 }}>
              <Screen {...props} />
            </View>
          </View>
        ) : (
          <Screen {...props} />
        )}
      </SpeakScope>
    );
  }
  Localized.displayName = `WithScreenLanguage(${Screen.displayName || Screen.name || "Screen"})`;
  return Localized;
}

const HomeScreenL = withScreenLanguage(HomeScreen, { bar: false });
const ChatScreenL = withScreenLanguage(ChatScreen, { bar: false });
const LiveTrackingScreenL = withScreenLanguage(LiveTrackingScreen, { bar: false });
const MoreToolsScreenL = withScreenLanguage(MoreToolsScreen);
const SettingsScreenL = withScreenLanguage(SettingsScreen);
const PnrStatusScreenL = withScreenLanguage(PnrStatusScreen);
const LiveTrainStatusScreenL = withScreenLanguage(LiveTrainStatusScreen);
const TrainScheduleScreenL = withScreenLanguage(TrainScheduleScreen);
const SeatAvailabilityScreenL = withScreenLanguage(SeatAvailabilityScreen);
const FareEnquiryScreenL = withScreenLanguage(FareEnquiryScreen);
const TrainSearchScreenL = withScreenLanguage(TrainSearchScreen);
const StationSearchScreenL = withScreenLanguage(StationSearchScreen);

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
  const { t } = useT();
  return (
    <HomeStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.primary },
        headerTintColor: colors.textInverse,
        headerTitleStyle: { fontWeight: "700" },
      }}
    >
      <HomeStack.Screen name="Home" component={HomeScreenL} options={{ title: t("Train Enquiry Center") }} />
      <HomeStack.Screen name="LiveTrainStatus" component={LiveTrainStatusScreenL} options={{ title: t("Live Train Status") }} />
      <HomeStack.Screen name="PnrStatus" component={PnrStatusScreenL} options={{ title: t("PNR Status") }} />
      <HomeStack.Screen name="TrainSchedule" component={TrainScheduleScreenL} options={{ title: t("Time Table") }} />
      <HomeStack.Screen name="SeatAvailability" component={SeatAvailabilityScreenL} options={{ title: t("Seat Availability") }} />
      <HomeStack.Screen name="FareEnquiry" component={FareEnquiryScreenL} options={{ title: t("Fare Calculator") }} />
      <HomeStack.Screen name="TrainsBetween" component={TrainSearchScreenL} options={{ title: t("Trains Between Stations") }} />
      <HomeStack.Screen name="StationSearch" component={StationSearchScreenL} options={{ title: t("Station Search") }} />
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
        <LanguageProvider>
          <AppTabs />
        </LanguageProvider>
      </SettingsProvider>
    </SafeAreaProvider>
  );
}

// Tabs live in their own component so their titles can use the chosen
// screen language (LanguageContext).
function AppTabs() {
  const { t } = useT();
  return (
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
            <Tab.Screen name="Home" component={HomeStackNavigator} options={{ title: t("Home"), headerShown: false }} />
            <Tab.Screen name="Chat" component={ChatScreenL} options={{ title: t("Railway Assistant") }} />
            <Tab.Screen name="Track" component={LiveTrackingScreenL} options={{ title: t("Live Tracking") }} />
            <Tab.Screen name="More" component={MoreToolsScreenL} options={{ title: t("More Tools") }} />
            <Tab.Screen name="Settings" component={SettingsScreenL} options={{ title: t("Settings") }} />
          </Tab.Navigator>
        </NavigationContainer>
  );
}
