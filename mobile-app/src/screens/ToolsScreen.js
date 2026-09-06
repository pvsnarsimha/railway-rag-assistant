import React, { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { colors, spacing, radius } from "../theme/colors";
import StationSearchScreen from "./StationSearchScreen";
import TrainSearchScreen from "./TrainSearchScreen";
import DelayPredictScreen from "./DelayPredictScreen";
import CrowdPredictScreen from "./CrowdPredictScreen";
import CrowdPositionScreen from "./CrowdPositionScreen";

const TABS = [
  { key: "trains", label: "Trains", Component: TrainSearchScreen },
  { key: "search", label: "Stations", Component: StationSearchScreen },
  { key: "delay", label: "Delay", Component: DelayPredictScreen },
  { key: "crowd", label: "Crowd", Component: CrowdPredictScreen },
  { key: "position", label: "GPS", Component: CrowdPositionScreen },
];

export default function ToolsScreen() {
  const [active, setActive] = useState("trains");
  const ActiveComponent = TABS.find((t) => t.key === active)?.Component;

  return (
    <View style={styles.flex}>
      <View style={styles.segmentRow}>
        {TABS.map((tab) => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.segment, active === tab.key && styles.segmentActive]}
            onPress={() => setActive(tab.key)}
          >
            <Text style={[styles.segmentText, active === tab.key && styles.segmentTextActive]}>{tab.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={styles.flex}>{ActiveComponent && <ActiveComponent />}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  segmentRow: {
    flexDirection: "row",
    backgroundColor: colors.card,
    padding: spacing.xs,
    margin: spacing.lg,
    marginBottom: 0,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  segment: { flex: 1, paddingVertical: spacing.sm, borderRadius: radius.pill, alignItems: "center" },
  segmentActive: { backgroundColor: colors.primary },
  segmentText: { fontSize: 13, fontWeight: "600", color: colors.textMuted },
  segmentTextActive: { color: colors.textInverse },
});
