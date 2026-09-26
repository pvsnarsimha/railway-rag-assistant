import React from "react";
import { Modal, View, TouchableOpacity, ScrollView, StyleSheet } from "react-native";
import { Text } from "../i18n/Localized";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius } from "../theme/colors";

/**
 * Bottom-sheet option list — the "Class" / "Quota" picker from the IRCTC
 * app (a title bar, a plain list of rows, a checkmark next to whichever
 * one is selected, tap any row to pick it and close). Reused for both the
 * Class and Quota fields on TrainSearchScreen so there's one place that
 * owns this look rather than two near-duplicate pickers.
 */
export default function OptionSheetModal({ visible, title, options, selectedKey, onSelect, onClose }) {
  return (
    <Modal visible={!!visible} animationType="slide" transparent onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
        {/* Swallow taps on the sheet itself so they don't bubble to the backdrop and close it */}
        <TouchableOpacity activeOpacity={1} style={styles.sheet} onPress={() => {}}>
          <View style={styles.handle} />
          <Text style={styles.title}>{title}</Text>
          <ScrollView style={styles.list} bounces={false}>
            {options.map((opt) => {
              const active = opt.key === selectedKey;
              return (
                <TouchableOpacity
                  key={opt.key}
                  style={styles.row}
                  onPress={() => {
                    onSelect(opt.key);
                    onClose();
                  }}
                >
                  <Text style={[styles.rowText, active && styles.rowTextActive]}>{opt.label}</Text>
                  {active ? <Ionicons name="checkmark" size={20} color={colors.orange} /> : null}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(20,24,33,0.45)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl,
    maxHeight: "70%",
  },
  handle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginBottom: spacing.md,
  },
  title: {
    fontSize: 17,
    fontWeight: "700",
    color: colors.text,
    marginBottom: spacing.sm,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  list: { flexGrow: 0 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowText: { fontSize: 15, color: colors.text },
  rowTextActive: { fontWeight: "700", color: colors.orange },
});
