// Checks for the GPS "is the phone really on this train?" test (utils/gpsOverlay.js).
// Run:  cd mobile-app && npx esbuild src/utils/gpsOverlay.js --bundle --platform=node --format=cjs --outfile=/tmp/gpsOverlay.cjs && node tests/gps-verdict.test.cjs
const g = require('/tmp/gpsOverlay.cjs');
const raw = (over={}) => ({ status_updated_at: new Date().toISOString(), display_speed_kmph: 80, distance_covered_since_last_stop_km: 10,
  timeline: [{status:'passed',distance_km:0},{status:'passed',distance_km:100},{status:'upcoming',distance_km:200},{status:'upcoming',distance_km:300}], ...over });
const ok = (n, c) => { console.log((c?'PASS':'FAIL'), n); if(!c) process.exitCode=1; };
const now = new Date();
// train at ~110 km
ok('on train (same place, moving)', g.checkGpsOnTrain(raw(), {currentKm:111, speedKmph:78}, now).ok === true);
ok('far from train rejected', g.checkGpsOnTrain(raw(), {currentKm:150, speedKmph:78}, now).reason === 'far');
ok('platform: same place but stationary rejected', g.checkGpsOnTrain(raw(), {currentKm:111, speedKmph:0}, now).reason === 'stationary');
ok('stationary ok when train is halted', g.checkGpsOnTrain(raw({display_speed_kmph:0, avg_speed_kmph:0}), {currentKm:111, speedKmph:0}, now).ok === true);
ok('not started rejected', g.checkGpsOnTrain({timeline:[{status:'upcoming',distance_km:0},{status:'upcoming',distance_km:100}], status_updated_at:new Date().toISOString()}, {currentKm:2, speedKmph:60}, now).reason === 'not_started');
ok('no live feed -> cannot verify, allowed', g.checkGpsOnTrain(null, {currentKm:50}, now).unknown === true);
ok('history-based stationary', g.checkGpsOnTrain(raw(), {currentKm:111}, now, [{km:111,t:now-120000},{km:111,t:+now}]).reason === 'stationary');
console.log(g.notOnTrainMessage({ok:false, reason:'far', gapKm:40, ahead:false}, '20834'));
