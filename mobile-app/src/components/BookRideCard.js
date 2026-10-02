import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, StyleSheet, TouchableOpacity, Linking, Platform, ScrollView, TextInput } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "../i18n/Localized";
import { scheduleLocalReminder, cancelLocalReminder, ensureLocalNotificationPermission } from "../services/pushNotifications";

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

const LEADS = [15, 30, 45];
const MAX_LEAD = 12 * 60;

/**
 * "Custom" reminder time typed by the rider: "5 min", "1 hr 20 min",
 * "1h20m", "1:20" (hh:mm) or a plain number of minutes. Minutes, or null.
 */
export function parseLead(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return null;
  let mins = null;
  const clock = /^(\d{1,2})\s*[:.]\s*(\d{1,2})$/.exec(t);
  if (clock) {
    if (Number(clock[2]) > 59) return null;
    mins = Number(clock[1]) * 60 + Number(clock[2]);
  } else if (/^\d+$/.test(t)) {
    mins = Number(t);
  } else {
    const h = /(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/.exec(t) || /(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)(?=\s*\d)/.exec(t);
    const m = /(\d+)\s*(?:m|min|mins|minute|minutes)\b/.exec(t);
    if (!h && !m) return null;
    const rest = t.replace(/(\d+(?:\.\d+)?)\s*(?:hours|hour|hrs|hr|h)/, "").replace(/(\d+)\s*(?:minutes|minute|mins|min|m)/, "").replace(/[\s,&+]|and/g, "");
    if (rest) return null;
    mins = Math.round((h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0));
  }
  return mins >= 1 && mins <= MAX_LEAD ? mins : null;
}

export function formatLead(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h) return `${m} min`;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

const reminderKey = (train) => `bookRide.reminder.${train || "any"}`;

/** Minutes from now until the train reaches `s` (live minutes_away, else its ETA clock time). */
function minutesUntil(s) {
  if (s?.minutes_away != null && Number.isFinite(Number(s.minutes_away))) return Number(s.minutes_away);
  const eta = stopEta(s);
  const m = eta && /^(\d{1,2}):(\d{2})$/.exec(eta);
  if (!m) return null;
  const now = new Date();
  const t = new Date(now);
  t.setHours(Number(m[1]), Number(m[2]), 0, 0);
  let diff = (t - now) / 60000;
  if (diff < -360) diff += 1440; // past midnight on an overnight run
  return Math.round(diff);
}

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
export default function BookRideCard({ timeline, dest, preferredCodes, trainNumber, defaultOpen, initialStopCode }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const initialStopRef = useRef(initialStopCode ? String(initialStopCode).toUpperCase() : null);
  const [remindOn, setRemindOn] = useState(false);
  const [lead, setLead] = useState(30);
  const [remindNote, setRemindNote] = useState(null);
  const reminderRef = useRef({ id: null, fireAt: null, key: null });
  const [picked, setPicked] = useState(null);
  const [chooseStop, setChooseStop] = useState(false);
  const [stopCode, setStopCode] = useState(initialStopCode ? String(initialStopCode).toUpperCase() : null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customText, setCustomText] = useState("");
  const [customErr, setCustomErr] = useState(null);
  const [restored, setRestored] = useState(false);

  // The reminder is an OS alarm, so it fires with the phone asleep or the
  // app swiped away. Its settings (and the alarm's id) are saved per train
  // so reopening the app shows it on — and doesn't schedule a second one.
  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(reminderKey(trainNumber)).then((raw) => {
      if (!alive) return;
      try {
        const v = JSON.parse(raw || "null");
        if (v) {
          if (v.lead > 0) setLead(v.lead);
          if (v.stopCode && !initialStopRef.current) setStopCode(v.stopCode);
          if (v.id) Object.assign(reminderRef.current, { id: v.id, fireAt: v.fireAt, key: v.key });
          setRemindOn(!!v.remindOn);
        }
      } catch (e) { /* start fresh */ }
      setRestored(true);
    }).catch(() => setRestored(true));
    return () => { alive = false; };
  }, [trainNumber]);

  const saveReminder = (extra = {}) => {
    const r = reminderRef.current;
    AsyncStorage.setItem(reminderKey(trainNumber), JSON.stringify({
      remindOn, lead, stopCode, id: r.id, fireAt: r.fireAt, key: r.key, ...extra,
    })).catch(() => {});
  };

  const applyCustom = () => {
    const mins = parseLead(customText);
    if (mins == null) { setCustomErr("Type a time like 5 min, 1 hr 20 min or 1:20 (hh:mm), up to 12 hr."); return; }
    setCustomErr(null);
    setLead(mins);
    setCustomOpen(false);
  };

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

  const code = stopCode && halts.some((s) => String(s.code).toUpperCase() === stopCode) ? stopCode : defaultCode;
  const stop = halts.find((s) => String(s.code).toUpperCase() === code) || halts[halts.length - 1] || null;
  const eta = stopEta(stop);
  const stationLabel = stop ? titleCase(stop.name || stop.code) : "";
  const chosen = PROVIDERS.find((p) => p.key === picked);
  const minsAway = stop ? minutesUntil(stop) : null;

  // "Remind me to book a ride": one notification `lead` min before the
  // train reaches the chosen station, with Ola / Uber / Rapido buttons.
  // Re-planned as the live ETA moves (only when it shifts by 2+ min).
  useEffect(() => {
    if (!restored) return;
    const r = reminderRef.current;
    const cancel = () => { if (r.id) cancelLocalReminder(r.id); r.id = null; r.fireAt = null; r.key = null; };
    if (!remindOn || !stop || minsAway == null) {
      if (!remindOn) cancel();
      setRemindNote(null);
      saveReminder();
      return;
    }
    const inSec = (minsAway - lead) * 60;
    if (inSec <= 30) {
      cancel();
      setRemindNote(minsAway > 0 ? `${stationLabel} is only ${minsAway} min away — book your ride now.` : null);
      saveReminder();
      return;
    }
    const fireAt = Date.now() + inSec * 1000;
    const key = `${stop.code}|${lead}`;
    if (r.id && r.key === key && Math.abs(r.fireAt - fireAt) < 2 * 60 * 1000) {
      setRemindNote(`We'll remind you at ${new Date(r.fireAt).toTimeString().slice(0, 5)}, ${formatLead(lead)} before ${stationLabel}.`);
      return;
    }
    cancel();
    const links = Object.fromEntries(PROVIDERS.map((p) => [p.key, rideLinks(p.key, stop).web]));
    const whenText = new Date(fireAt).toTimeString().slice(0, 5);
    setRemindNote(`We'll remind you at ${whenText}, ${formatLead(lead)} before ${stationLabel}.`);
    scheduleLocalReminder(
      `Book your ride — ${stationLabel} in ~${formatLead(lead)}`,
      `${trainNumber ? `${trainNumber} ` : ""}reaches ${stationLabel}${eta ? ` at about ${eta}` : ""}. Pick Ola, Uber or Rapido to have a ride waiting at the exit.`,
      inSec,
      {
        categoryIdentifier: "ride_book",
        data: { type: "ride_reminder", stop: { code: stop.code, name: stop.name, lat: stop.lat, lng: stop.lng }, links },
        webActions: [{ action: "ride_uber", title: "Uber" }, { action: "ride_ola", title: "Ola" }],
      },
    ).then((id) => {
      r.id = id; r.fireAt = fireAt; r.key = key;
      if (!id && Platform.OS !== "web") setRemindNote("Couldn't set the reminder — allow notifications for this app in Android settings.");
      saveReminder({ id, fireAt, key });
    });
  }, [restored, remindOn, lead, stop?.code, minsAway]); // eslint-disable-line react-hooks/exhaustive-deps

  // Card gone (tracking stopped / trip over): cancel the alarm. The saved
  // choice brings it back if this train is tracked again. A swiped-away
  // app never gets here, so its alarm still fires.
  useEffect(() => () => { const r = reminderRef.current; if (r.id) cancelLocalReminder(r.id); r.id = null; }, []);

  if (!halts.length || !stop) return null;

  const stopChips = (
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
  );

  return (
    <View style={styles.card}>
      <Text style={styles.lead}>
        <Text style={{ fontWeight: "800" }}>{eta ? `Reaching ${stationLabel} at ${eta}.` : `Getting off at ${stationLabel}.`}</Text>
        {" "}Get a ride waiting at the exit.
      </Text>

      <View style={styles.remind}>
        <TouchableOpacity
          style={styles.remindRow}
          activeOpacity={0.8}
          onPress={() => { if (!remindOn) ensureLocalNotificationPermission(); setRemindOn((v) => !v); }}
          accessibilityState={{ checked: remindOn }}
        >
          <Ionicons name={remindOn ? "notifications" : "notifications-outline"} size={18} color={remindOn ? "#E4570F" : "#6B7280"} />
          <Text style={styles.remindText}>Remind me to book a ride</Text>
          <View style={[styles.switch, remindOn && styles.switchOn]}>
            <View style={[styles.knob, remindOn && styles.knobOn]} />
          </View>
        </TouchableOpacity>
        {remindOn ? (
          <>
            <TouchableOpacity style={styles.pickupRow} onPress={() => setChooseStop((v) => !v)} activeOpacity={0.7}>
              <Ionicons name="location" size={15} color="#E4570F" />
              <Text style={styles.pickupText} numberOfLines={1}>Before {stationLabel} ({stop.code}){eta ? ` · ${eta}` : ""}</Text>
              <Text style={styles.changeLink}>{chooseStop ? "Done" : "Change"}</Text>
            </TouchableOpacity>
            {chooseStop ? stopChips : null}
            <View style={styles.leadRow}>
              <Text style={styles.leadLabel}>Notify</Text>
              {LEADS.map((m) => (
                <TouchableOpacity key={m} onPress={() => { setLead(m); setCustomOpen(false); }} style={[styles.leadChip, lead === m && !customOpen && styles.leadChipOn]}>
                  <Text style={[styles.leadText, lead === m && !customOpen && { color: "#fff" }]}>{m} min</Text>
                </TouchableOpacity>
              ))}
              {(() => {
                const isCustom = customOpen || !LEADS.includes(lead);
                return (
                  <TouchableOpacity
                    onPress={() => { setCustomOpen(true); setCustomErr(null); setCustomText(LEADS.includes(lead) ? "" : formatLead(lead)); }}
                    style={[styles.leadChip, isCustom && styles.leadChipOn]}
                  >
                    <Text style={[styles.leadText, isCustom && { color: "#fff" }]}>
                      {!customOpen && !LEADS.includes(lead) ? formatLead(lead) : "Custom"}
                    </Text>
                  </TouchableOpacity>
                );
              })()}
              <Text style={styles.leadLabel}>before</Text>
            </View>
            {customOpen ? (
              <View style={styles.customBox}>
                <Text style={styles.customLabel}>How long before {stationLabel}?</Text>
                <View style={styles.customRow}>
                  <TextInput
                    value={customText}
                    onChangeText={(v) => { setCustomText(v); setCustomErr(null); }}
                    onSubmitEditing={applyCustom}
                    placeholder="e.g. 5 min, 1 hr 20 min or 1:20"
                    placeholderTextColor="#B08968"
                    autoFocus
                    returnKeyType="done"
                    style={styles.customInput}
                  />
                  <TouchableOpacity onPress={applyCustom} style={styles.customSet}>
                    <Text style={styles.customSetText}>Set</Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.customQuick}>
                  {[5, 10, 60, 80].map((m) => (
                    <TouchableOpacity key={m} onPress={() => { setCustomText(formatLead(m)); setCustomErr(null); }} style={styles.quickChip}>
                      <Text style={styles.quickText}>{formatLead(m)}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                {customErr ? <Text style={styles.customErr}>{customErr}</Text> : null}
              </View>
            ) : null}
            {remindNote ? <Text style={styles.note}>{remindNote}</Text> : null}
          </>
        ) : null}
      </View>

      {open ? (
        <View style={styles.panel}>
          <TouchableOpacity style={styles.pickupRow} onPress={() => setChooseStop((v) => !v)} activeOpacity={0.7}>
            <Ionicons name="location" size={15} color="#E4570F" />
            <Text style={styles.pickupText} numberOfLines={2}>
              Pickup at {stationLabel} ({stop.code}), main exit{eta ? `, ${eta}` : ""}
            </Text>
            <Text style={styles.changeLink}>{chooseStop ? "Done" : "Change"}</Text>
          </TouchableOpacity>
          {chooseStop && !remindOn ? stopChips : null}

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
  remind: { marginTop: 12, borderRadius: 16, backgroundColor: "#FFF7ED", padding: 10, gap: 8 },
  remindRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  remindText: { flex: 1, fontSize: 14, fontWeight: "800", color: "#111827" },
  switch: { width: 40, height: 24, borderRadius: 12, backgroundColor: "#D1D5DB", padding: 2, justifyContent: "center" },
  switchOn: { backgroundColor: "#E4570F" },
  knob: { width: 20, height: 20, borderRadius: 10, backgroundColor: "#fff" },
  knobOn: { alignSelf: "flex-end" },
  leadRow: { flexDirection: "row", gap: 6, flexWrap: "wrap", alignItems: "center" },
  leadLabel: { fontSize: 12.5, color: "#6B7280", marginRight: 2 },
  leadChip: { paddingHorizontal: 11, paddingVertical: 7, borderRadius: 999, backgroundColor: "#fff", borderWidth: 1, borderColor: "#F3D5BE" },
  leadChipOn: { backgroundColor: "#E4570F", borderColor: "#E4570F" },
  leadText: { fontSize: 12.5, fontWeight: "700", color: "#9A3412" },
  customBox: { backgroundColor: "#fff", borderRadius: 14, borderWidth: 1, borderColor: "#F3D5BE", padding: 10, gap: 8 },
  customLabel: { fontSize: 12.5, fontWeight: "700", color: "#9A3412" },
  customRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  customInput: {
    flex: 1, borderWidth: 1, borderColor: "#F3D5BE", borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9,
    fontSize: 15, color: "#111827", backgroundColor: "#FFFBF7",
  },
  customSet: { backgroundColor: "#E4570F", borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10 },
  customSetText: { color: "#fff", fontWeight: "800", fontSize: 14 },
  customQuick: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  quickChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, backgroundColor: "#FFF7ED", borderWidth: 1, borderColor: "#F3D5BE" },
  quickText: { fontSize: 12, fontWeight: "700", color: "#9A3412" },
  customErr: { fontSize: 12, color: "#B91C1C", fontWeight: "600" },
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
