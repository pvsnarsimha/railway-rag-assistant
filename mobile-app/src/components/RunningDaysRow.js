import React from "react";
import { View, StyleSheet } from "react-native";
import { Text } from "../i18n/AutoText";
import { colors, spacing } from "../theme/colors";

const DAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"]; // Mon..Sun, index matches backend's running_days (0=Mon..6=Sun)

/**
 * IRCTC's "M T W T F S S" running-days row — the day letters for a train
 * that DOESN'T run are shown struck through, the ones it DOES run are
 * shown solid. `runningDays` is the list of weekday indices (0=Mon..6=Sun)
 * trains_between.py's train_to_dict() now returns (parsed server-side from
 * whatever raw shape the provider sent), or null when that field couldn't
 * be recognised for this particular train.
 *
 * Honesty rule carried over from the backend (see train_to_dict's own
 * comment): null means "unconfirmed", not "runs no days" — rendered here
 * as every letter solid/neutral (never struck through), since striking a
 * day through is a claim that the train confirmed doesn't run that day.
 */
export default function RunningDaysRow({ runningDays }) {
  const known = Array.isArray(runningDays);
  return (
    <View style={styles.row}>
      {DAY_LETTERS.map((letter, idx) => {
        const runs = !known || runningDays.includes(idx);
        return (
          <Text
            key={idx}
            style={[
              styles.letter,
              runs ? styles.letterActive : styles.letterInactive,
            ]}
          >
            {letter}
          </Text>
        );
      })}
      {!known ? <Text style={styles.unknownNote}>running days not confirmed</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", marginTop: 4, marginBottom: 2 },
  letter: {
    fontSize: 11,
    fontWeight: "700",
    width: 14,
    textAlign: "center",
  },
  letterActive: { color: colors.runDayActive },
  letterInactive: {
    color: colors.runDayInactive,
    textDecorationLine: "line-through",
  },
  unknownNote: { fontSize: 9, color: colors.textMuted, fontStyle: "italic", marginLeft: spacing.xs },
});
