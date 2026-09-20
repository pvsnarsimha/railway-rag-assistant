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

  // IRCTC-style orange — used by the Trains Between Stations redesign
  // (results header, Class/Quota picker checkmarks, Tatkal accents,
  // StationField.js's From/To dropdown, OptionSheetModal.js's selected
  // row) so that flow reads as its own distinct "booking" surface rather
  // than reusing the app's railway-blue chrome everywhere.
  orange: "#E85D25",
  orangeDark: "#C94A1B",
  orangeLight: "#FCE8DD",
  // Two flat tones stood in for the header's real diagonal gradient (no
  // gradient library in this project's deps — see the header comment in
  // TrainSearchScreen.js) — kept here so the "gradient" is defined once,
  // not re-picked per screen.
  headerGradientFrom: "#F0742E",
  headerGradientTo: "#C94A1B",
  runDayActive: "#1E8E3E",
  runDayInactive: "#B7BECB",
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
