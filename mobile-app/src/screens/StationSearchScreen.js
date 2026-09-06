import React, { useState } from "react";
import { View, Text, StyleSheet, FlatList } from "react-native";
import { colors, spacing, radius } from "../theme/colors";
import SectionCard from "../components/SectionCard";
import LabeledInput from "../components/LabeledInput";
import PrimaryButton from "../components/PrimaryButton";
import { useSettings } from "../context/SettingsContext";
import { searchStations } from "../api/railwayApi";
import { describeApiError } from "../api/client";

export default function StationSearchScreen() {
  const { apiBaseUrl } = useSettings();
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState(null);
  const [note, setNote] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function runSearch() {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const data = await searchStations(apiBaseUrl, { query: query.trim(), topK: 10 });
      setMatches(data.matches || []);
      setNote(data.note);
    } catch (e) {
      setError(describeApiError(e));
      setMatches(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.flex}>
      <View style={styles.content}>
        <SectionCard title="Station search" subtitle="Find a station by name, city, or fuzzy spelling.">
          <LabeledInput
            label="Search"
            placeholder="e.g. Vijayawada, or 'vijaywada' misspelled"
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
          />
          <PrimaryButton title="Search" onPress={runSearch} loading={loading} />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {note ? <Text style={styles.note}>{note}</Text> : null}
        </SectionCard>
      </View>

      <FlatList
        data={matches || []}
        keyExtractor={(item, idx) => `${item.code}_${idx}`}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => (
          <View style={styles.matchRow}>
            <View style={styles.codeBadge}>
              <Text style={styles.codeBadgeText}>{item.code}</Text>
            </View>
            <View style={styles.matchInfo}>
              <Text style={styles.matchName}>{item.name}</Text>
              <Text style={styles.matchMeta}>
                matched on {item.matched_on} · score {item.score?.toFixed?.(2) ?? item.score}
              </Text>
            </View>
          </View>
        )}
        ListEmptyComponent={
          matches ? <Text style={styles.emptyText}>No matches found.</Text> : null
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: 0 },
  listContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
  error: { color: colors.danger, fontSize: 12, marginTop: spacing.sm },
  note: { color: colors.textMuted, fontSize: 11, marginTop: spacing.sm, fontStyle: "italic" },
  matchRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  codeBadge: {
    backgroundColor: colors.chip,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    marginRight: spacing.md,
    minWidth: 52,
    alignItems: "center",
  },
  codeBadgeText: { fontSize: 12, fontWeight: "700", color: colors.primary },
  matchInfo: { flex: 1 },
  matchName: { fontSize: 14, fontWeight: "600", color: colors.text },
  matchMeta: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  emptyText: { textAlign: "center", color: colors.textMuted, marginTop: spacing.lg },
});
