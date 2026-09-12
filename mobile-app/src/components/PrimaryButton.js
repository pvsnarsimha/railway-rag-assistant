import React from "react";
import { TouchableOpacity, Text, ActivityIndicator, StyleSheet } from "react-native";
import { colors, spacing, radius } from "../theme/colors";

export default function PrimaryButton({ title, onPress, loading, disabled, variant = "primary", style }) {
  const isSecondary = variant === "secondary";
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.8}
      style={[
        styles.base,
        isSecondary ? styles.secondary : styles.primary,
        (disabled || loading) && styles.disabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={isSecondary ? colors.primary : colors.textInverse} />
      ) : (
        <Text style={isSecondary ? styles.secondaryText : styles.primaryText}>{title}</Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.pill,
    paddingVertical: spacing.md,
    alignItems: "center",
    justifyContent: "center",
  },
  primary: { backgroundColor: colors.primary },
  secondary: { backgroundColor: colors.chip, borderWidth: 1, borderColor: colors.primary },
  disabled: { opacity: 0.5 },
  primaryText: { color: colors.textInverse, fontWeight: "700", fontSize: 15 },
  secondaryText: { color: colors.primary, fontWeight: "700", fontSize: 15 },
});
