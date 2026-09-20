// Central theme so every screen looks like one app, not five prototypes.
export const colors = {
  primary: "#0B3D91", // Indian Railways blue
  primaryDark: "#082a66",
  accent: "#E8912D", // signal amber
  success: "#1E8E3E",
  danger: "#D93025",
  warning: "#F2A600",
  bg: "#F5F7FA",
  card: "#FFFFFF",
  border: "#E2E6EC",
  text: "#1A2233",
  textMuted: "#67728A",
  textInverse: "#FFFFFF",
  bubbleUser: "#0B3D91",
  bubbleAssistant: "#FFFFFF",
  chip: "#EEF2FA",
  // IRCTC-style warm accent, used only by the Train Search screen's
  // header/date-chips/search button (see TrainSearchScreen.js) — kept as
  // its own tokens rather than repurposing `accent` so every other screen
  // that already uses `accent` (signal amber) is completely unaffected.
  orange: "#EF6C1B",
  orangeDark: "#C6510F",
  orangeSoft: "#FDECE0",
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 18,
  pill: 999,
};

export default { colors, spacing, radius };
