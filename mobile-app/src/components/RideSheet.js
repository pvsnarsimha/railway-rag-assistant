import React from "react";
import { View, StyleSheet, TouchableOpacity, Modal, ScrollView } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "../i18n/Localized";
import BookRideCard from "./BookRideCard";
import { colors } from "../theme/colors";

/**
 * Full-screen "Ride from station": arrival summary on top, then the existing
 * BookRideCard (Ola / Uber / Rapido with pickup pre-set + "remind me to book").
 * No fares are shown — booking happens in the provider's own app.
 */
export default function RideSheet({ visible, onClose, stationName, etaClock, timeline, dest, preferredCodes, trainNumber }) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        <View style={styles.top}>
          <View style={styles.bar}>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} style={styles.back}>
              <Ionicons name="chevron-back" size={20} color="#fff" />
              <Text style={styles.backText}>Back</Text>
            </TouchableOpacity>
            <Text style={styles.title}>Ride from station</Text>
            <View style={{ width: 60 }} />
          </View>
          <Text style={styles.arriving}>{stationName ? `Arriving ${stationName}` : "Your arrival"}</Text>
          <Text style={styles.eta}>{etaClock || "--:--"}</Text>
        </View>
        <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: 40 }}>
          <BookRideCard timeline={timeline} dest={dest} preferredCodes={preferredCodes} trainNumber={trainNumber} defaultOpen />
          <Text style={styles.foot}>Fares and wait times are shown in the ride app — they change by the minute.</Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  top: { backgroundColor: "#0B6B46", paddingTop: 14, paddingBottom: 22, paddingHorizontal: 16, borderBottomLeftRadius: 26, borderBottomRightRadius: 26 },
  bar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 14 },
  back: { width: 60, flexDirection: "row", alignItems: "center" },
  backText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  title: { color: "#fff", fontSize: 17, fontWeight: "800" },
  arriving: { color: "rgba(255,255,255,0.85)", fontSize: 13.5 },
  eta: { color: "#fff", fontSize: 40, fontWeight: "900", marginTop: 2 },
  foot: { textAlign: "center", color: colors.textMuted, fontSize: 12, marginTop: 14 },
});
