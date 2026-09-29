import React, { useMemo, useState } from "react";
import { View, StyleSheet, TouchableOpacity, Linking, Platform, ScrollView } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "../i18n/Localized";

/**
 * "Book a ride" on Live Tracking: pick Ola, Uber or Rapido and we open that
 * app (or its website in the browser when the app isn't installed) with the
 * pickup already set to the station the rider gets off at, so the cab can
 * be waiting at the exit.
 *
 * Booking itself happens in the ride app — none of them offer a public API
 * for booking from another app — so fares and wait times show there.
 * Uber and Ola take the pickup point from the link; Rapido's link has no
 * pickup parameter, so the rider sets it in Rapido.
 */

const PROVIDERS = [
  { key: "ola", name: "Ola", types: "Auto, Mini, Prime Sedan", bg: "#1C8C3B", icon: "car-sport" },
  { key: "uber", name: "Uber", types: "Go, Auto, Moto", bg: "#111111", icon: "car" },
  { key: "rapido", name: "Rapido", types: "Bike, Auto, Cab", bg: "#F9C80E", fg: "#1A1300", icon: "bicycle" },
];

const titleCase = (s) => String(s || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const hhmm = (v) => (v ? String(v).slice(0, 5) : null);

function stopEta(s) {
  return hhmm(s?.predicted_eta || s?.arrival?.expected || s?.arrival?.scheduled);
}

/** App deep link + web fallback for a provider, pickup at the station. */
export function rideLinks(provider, stop) {
  const name = `${titleCase(stop?.name || stop?.code || "")} Railway Station`;
  const lat = stop?.lat;
  const lng = stop?.lng;
  const has = lat != null && lng != null;
  const q = encodeURIComponent;
  if (provider === "uber") {
    // Uber's universal link opens the app when installed, else m.uber.com.
    const url = has
      ? `https://m.uber.com/ul/?action=setPickup&pickup[latitude]=${lat}&pickup[longitude]=${lng}`
        + `&pickup[nickname]=${q(name)}&pickup[formatted_address]=${q(name)}`
      : "https://m.uber.com/ul/?action=setPickup&pickup=my_location";
    return { app: url, web: url };
  }
  if (provider === "ola") {
    return {
      app: has ? `olacabs://app/launch?lat=${lat}&lng=${lng}&landing_page=bk&utm_source=railway_assistant` : "olacabs://app/launch",
      web: has
        ? `https://book.olacabs.com/?lat=${lat}&lng=${lng}&pickup_name=${q(name)}&serviceType=p2p&utm_source=railway_assistant`
        : "https://book.olacabs.com/",
    };
  }
  return { app: "rapido://", web: "https://www.rapido.bike/" };
}

export async function openRide(provider, stop) {
  const { app, web } = rideLinks(provider, stop);
  if (Platform.OS === "web") {
    // Browser: custom app schemes fail silently, so use the https link.
    try { window.open(web, "_blank", "noopener"); } catch (e) { Linking.openURL(web).catch(() => {}); }
    return;
  }
  try {
    await Linking.openURL(app);
  } catch (e) {
    // App not installed -> its website in the browser (Chrome).
    Linking.openURL(web).catch(() => {});
  }
}

/**
 * timeline: live-status timeline rows ({code, name, lat, lng, status, kind,
 * arrival, predicted_eta}); dest: the "Dest" station code the rider typed
 * (optional); preferredCodes: stations with an armed alert bell.
 */
export default function BookRideCard({ timeline, dest, preferredCodes }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState(null);
  const [chooseStop, setChooseStop] = useState(false);
  const [stopCode, setStopCode] = useState(null);

  // Upcoming halts the rider could get off at.
  const halts = useMemo(() => {
    const rows = (timeline || []).filter((s) => s && s.code && s.kind !== "intermediate");
    let lastPassed = -1;
    rows.forEach((s, i) => { if (s.status === "passed" || s.status === "current") lastPassed = i; });
    return rows.slice(lastPassed + 1);
  }, [timeline]);

  const defaultCode = useMemo(() => {
    const codes = halts.map((s) => String(s.code).toUpperCase());
    const d = String(dest || "").trim().toUpperCase();
    if (d && codes.includes(d)) return d;
    const bells = (preferredCodes || []).map((c) => String(c).toUpperCase()).filter((c) => codes.includes(c));
    if (bells.length) return bells[bells.length - 1];
    return codes[codes.length - 1] || null;
  }, [halts, dest, preferredCodes]);

  if (!halts.length) return null;
  const code = stopCode && halts.some((s) => String(s.code).toUpperCase() === stopCode) ? stopCode : defaultCode;
  const stop = halts.find((s) => String(s.code).toUpperCase() === code) || halts[halts.length - 1];
  const eta = stopEta(stop);
  const stationLabel = titleCase(stop.name || stop.code);
  const chosen = PROVIDERS.find((p) => p.key === picked);

  return (
    <View style={styles.card}>
      <Text style={styles.lead}>
        <Text style={{ fontWeight: "800" }}>{eta ? `Reaching ${stationLabel} at ${eta}.` : `Getting off at ${stationLabel}.`}</Text>
        {" "}Get a ride waiting at the exit.
      </Text>

      {open ? (
        <View style={styles.panel}>
          <TouchableOpacity style={styles.pickupRow} onPress={() => setChooseStop((v) => !v)} activeOpacity={0.7}>
            <Ionicons name="location" size={15} color="#E4570F" />
            <Text style={styles.pickupText} numberOfLines={2}>
              Pickup at {stationLabel} ({stop.code}), main exit{eta ? `, ${eta}` : ""}
            </Text>
            <Text style={styles.changeLink}>{chooseStop ? "Done" : "Change"}</Text>
          </TouchableOpacity>
          {chooseStop ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.stopChips}>
              {halts.map((s) => {
                const c = String(s.code).toUpperCase();
                const on = c === code;
                return (
                  <TouchableOpacity key={c} onPress={() => { setStopCode(c); setChooseStop(false); }} style={[styles.stopChip, on && styles.stopChipOn]}>
                    <Text noTranslate style={[styles.stopChipText, on && { color: "#fff" }]}>{titleCase(s.name || c)}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          ) : null}

          {PROVIDERS.map((p) => {
            const on = picked === p.key;
            return (
              <TouchableOpacity
                key={p.key}
                style={[styles.option, on && styles.optionOn]}
                onPress={() => setPicked(p.key)}
                activeOpacity={0.8}
                accessibilityState={{ selected: on }}
              >
                <View style={[styles.logo, { backgroundColor: p.bg }]}>
                  <Ionicons name={p.icon} size={18} color={p.fg || "#fff"} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text noTranslate style={styles.optName}>{p.name}</Text>
                  <Text style={styles.optTypes}>{p.types}</Text>
                </View>
                {on ? (
                  <Ionicons name="checkmark-circle" size={22} color="#111827" />
                ) : (
                  <Ionicons name="chevron-forward" size={18} color="#9CA3AF" />
                )}
              </TouchableOpacity>
            );
          })}
          <Text style={styles.note}>
            Fares and wait times show in the ride app.{picked === "rapido" ? " Set the pickup to the station in Rapido." : ""}
          </Text>
        </View>
      ) : null}

      <TouchableOpacity
        style={styles.button}
        activeOpacity={0.85}
        onPress={() => {
          if (open && chosen) { openRide(chosen.key, stop); return; }
          setOpen((v) => !v);
        }}
      >
        <Ionicons name="car-outline" size={18} color="#FACC15" />
        <Text style={styles.buttonText}>{open && chosen ? `Continue in ${chosen.name}` : "Book a ride"}</Text>
        <Ionicons name={open && chosen ? "arrow-forward" : open ? "chevron-down" : "chevron-up"} size={16} color="#fff" />
      </TouchableOpacity>
      {open && chosen ? (
        <TouchableOpacity onPress={() => { setOpen(false); setPicked(null); }} style={styles.cancel}>
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 12, marginTop: 12, padding: 14, borderRadius: 20, backgroundColor: "#FFFFFF",
    borderWidth: 1, borderColor: "#E8ECF2",
    shadowColor: "#0F1B33", shadowOpacity: 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 2,
  },
  lead: { fontSize: 13.5, color: "#374151", lineHeight: 19 },
  panel: { marginTop: 12, borderRadius: 16, backgroundColor: "#F7F8FA", padding: 10, gap: 8 },
  pickupRow: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 2, paddingBottom: 2 },
  pickupText: { flex: 1, fontSize: 12.5, color: "#4B5563" },
  changeLink: { fontSize: 12.5, fontWeight: "800", color: "#2563EB" },
  stopChips: { gap: 6, paddingVertical: 2 },
  stopChip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, backgroundColor: "#fff", borderWidth: 1, borderColor: "#E3E8EF" },
  stopChipOn: { backgroundColor: "#111827", borderColor: "#111827" },
  stopChipText: { fontSize: 12.5, fontWeight: "700", color: "#111827" },
  option: {
    flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: "#fff", borderRadius: 14,
    paddingVertical: 11, paddingHorizontal: 12, borderWidth: 1.5, borderColor: "#EEF1F5",
  },
  optionOn: { borderColor: "#111827", backgroundColor: "#FFFBEB" },
  logo: { width: 38, height: 38, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  optName: { fontSize: 15, fontWeight: "800", color: "#111827" },
  optTypes: { fontSize: 12, color: "#6B7280", marginTop: 1 },
  note: { fontSize: 11.5, color: "#6B7280", paddingHorizontal: 2 },
  button: {
    marginTop: 12, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: "#0B1422", borderRadius: 16, paddingVertical: 15,
  },
  buttonText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  cancel: { alignSelf: "center", paddingVertical: 8, paddingHorizontal: 16 },
  cancelText: { color: "#6B7280", fontSize: 13, fontWeight: "700" },
});
