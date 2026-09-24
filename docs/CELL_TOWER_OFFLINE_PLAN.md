# Offline Live Tracking — GPS now, cell towers next

## What works today (no extra setup)

| Situation | What the app uses | Where |
|---|---|---|
| Online | Live data (RailKit / RailRadar), same as before. The route and timetable are saved on the phone every minute. | `OfflineTrackingCard.js`, `utils/offlineTracker.js` |
| No internet, GPS on | **Phone GPS.** GPS talks to satellites, so it needs no internet or mobile data. The fix is snapped onto the saved route to show "Crossed X · N km to Y · next halt est. HH:MM". | web: `navigator.geolocation`; native: `expo-location` |
| No internet, no GPS fix | **Timetable estimate**: the saved schedule plus the last known live delay, clearly labelled as an estimate. | `estimateFromTimetable()` |

The web app (`/mobile-app`) also opens offline now. Its service worker caches the app shell (network-first, so online you always get the latest deploy). You need to open it once while online.

**Why not cell towers on the web?** Browsers do not expose cell-tower IDs through any API. Expo Go can't either, because it can't load custom native code. RailYatri's offline mode works because it is a native Android app.

## Cell-tower mode: how it works (RailYatri's approach)

1. **Read the serving tower (native, Android).** `TelephonyManager.getAllCellInfo()` gives MCC, MNC, LAC/TAC and Cell ID. It works with mobile data off, because the phone stays registered to a tower for calls and SMS. The code is in `mobile-app/native-modules-plan/cell-tower/` (Kotlin, Expo Modules API).
2. **Tower → location table.** Tower IDs mean nothing on their own, so you need a table that maps each tower to a location:
   * **Crowdsourced (already built):** when a user is online with a sharp GPS fix, the app sends the pair (tower, lat/lng) to `POST /api/offline/cell-observations`. The backend keeps a running average per tower (`backend/cell_tower_store.py`). This is how RailYatri built its own map.
   * **Seed data (optional, recommended):** load OpenCelliD's open India data (MCC 404/405). Keep only towers within 5 km of a station using `python backend/tools/import_opencellid.py 404.csv.gz 405.csv.gz`. The data is licensed CC BY-SA 4.0, so credit "OpenCelliD Project" in the app.
3. **Download before the trip.** While online, the phone calls `POST /api/offline/cell-map` with its train's route coordinates. It gets back only the towers near that route and stores them on the phone (`utils/cellTower.js → downloadCellMap`).
4. **Offline.** Every 30 s the app reads the serving tower, looks it up in the downloaded map to get lat/lng, then snaps that onto the route (`locateOnRoute(..., {source: "cell"})`). Priority is GPS first (more accurate). Cell towers are the fallback when GPS is off or indoors, since they are cheap on battery and work anywhere with signal. The timetable estimate is the last resort.

All the JS and backend wiring above is **already in place**. `isCellTowerAvailable()` just returns `false` until the native module exists.

## Enabling cell-tower mode

1. Move the module into Expo's autolinking folder:
   ```bash
   cd mobile-app
   mkdir -p modules && git mv native-modules-plan/cell-tower modules/cell-tower
   ```
2. Build a development client (Expo Go can't load it):
   ```bash
   npm install -g eas-cli && eas login
   eas build:configure
   eas build --profile development --platform android
   ```
   Install the APK, then run `npx expo start --dev-client`.
3. Seed the tower DB (step 2 above), or just let crowdsourcing fill it as people use the app.
4. On Render's free tier the SQLite file is wiped on every redeploy. Attach a persistent disk, or move `cell_towers.db` to a hosted DB, before relying on crowdsourced data.

## Accuracy you can expect

* GPS: 5–30 m. Km-to-next-station is accurate to about 0.1 km.
* Cell tower: 300 m–3 km in cities and up to about 5 km in rural stretches. Good enough to say which two stations the train is between, but not for exact km.
* Timetable: as good as the last known delay. The accuracy drops the longer you've been offline.
