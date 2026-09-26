import React from "react";
import { Modal, View, Text, TouchableOpacity, ScrollView, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius } from "../theme/colors";
import { LANGUAGES } from "../utils/notifyLanguage";

/**
 * FEATURE: "In which language should we show and read your train
 * notifications?" — English + the 22 Eighth-Schedule languages, each shown
 * in its own script with the English name underneath, so someone who
 * can't read English can still find their language.
 */
export default function LanguagePickerModal({ visible, selected, onSelect, onClose }) {
  return (
    <Modal visible={!!visible} animationType="slide" transparent onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={styles.sheet} onPress={() => {}}>
          <View style={styles.handle} />
          <Text style={styles.title}>Notification language</Text>
          <Text style={styles.subtitle}>
            भाषा चुनें · భాష ఎంచుకోండి · மொழியைத் தேர்ந்தெடுக்கவும் · ভাষা বেছে নিন
          </Text>
          <Text style={styles.hint}>Train notifications will be shown and read aloud in this language.</Text>
          <ScrollView style={styles.list} bounces={false}>
            <View style={styles.grid}>
              {LANGUAGES.map((l) => {
                const active = l.code === selected;
                return (
                  <TouchableOpacity
                    key={l.code}
                    style={[styles.cell, active && styles.cellActive]}
                    onPress={() => onSelect(l.code)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={l.name}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.native, active && styles.nativeActive]}>{l.native}</Text>
                      {l.native !== l.name ? <Text style={styles.english}>{l.name}</Text> : null}
                    </View>
                    {active ? <Ionicons name="checkmark-circle" size={20} color={colors.primary} /> : null}
                  </TouchableOpacity>
                );
              })}
            </View>
          </ScrollView>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.card, borderTopLeftRadius: 18, borderTopRightRadius: 18,
    paddingHorizontal: spacing.lg || 16, paddingBottom: spacing.lg || 16, maxHeight: "85%",
  },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginVertical: 10 },
  title: { fontSize: 18, fontWeight: "700", color: colors.text },
  subtitle: { fontSize: 13, color: colors.textMuted, marginTop: 4 },
  hint: { fontSize: 13, color: colors.text, marginTop: 6, marginBottom: 10 },
  list: { flexGrow: 0 },
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between" },
  cell: {
    width: "48.5%", flexDirection: "row", alignItems: "center", marginBottom: 8,
    paddingVertical: 10, paddingHorizontal: 12, borderRadius: radius?.md || 10,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg,
  },
  cellActive: { borderColor: colors.primary, backgroundColor: colors.chip },
  native: { fontSize: 17, color: colors.text, fontWeight: "600" },
  nativeActive: { color: colors.primary },
  english: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
});
