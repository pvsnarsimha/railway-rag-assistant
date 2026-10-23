// Run: cd mobile-app && npx esbuild src/utils/walkGuide.js --bundle --platform=node --format=cjs --outfile=/tmp/walkGuide.cjs && node tests/walk-guide.test.cjs
const g = require('/tmp/walkGuide.cjs');
const ok = (n, c) => { console.log(c ? 'PASS' : 'FAIL', n); if (!c) process.exitCode = 1; };
// ~ straight street going north from (16.5000,80.6000); turn at +100 m, pickup at +200 m east.
const A = { lat: 16.5000, lng: 80.6000 };
const T = { lat: 16.5009, lng: 80.6000 };            // ~100 m north
const D = { lat: 16.5009, lng: 80.6019 };            // ~200 m east of turn
const route = { steps: [
  { text: 'Start walking on Station Road', meters: 100, ...A },
  { text: 'Turn right onto Clock Tower Road', meters: 200, ...T },
  { text: 'You have arrived at your pickup point', meters: 0, ...D }],
  geometry: [[A.lat, A.lng], [T.lat, T.lng], [D.lat, D.lng]] };
let st = g.newGuideState();
let r = g.guideTick(st, A, route, D); st = r.state;
ok('starts with a spoken first instruction', r.say.length === 1 && /then turn right/.test(r.say[0]));
r = g.guideTick(st, { lat: 16.5003, lng: 80.6000 }, route, D); st = r.state;
ok('far from turn: silent', r.say.length === 0 && r.nextDistM > 60);
r = g.guideTick(st, { lat: 16.50065, lng: 80.6000 }, route, D); st = r.state;
ok('approaching turn: warns once', r.say.length === 1 && /In \d+ metres, turn right/.test(r.say[0]));
r = g.guideTick(st, { lat: 16.50070, lng: 80.6000 }, route, D); st = r.state;
ok('does not repeat the warning', r.say.length === 0);
r = g.guideTick(st, { lat: 16.50092, lng: 80.60005 }, route, D); st = r.state;
ok('after the turn, next is the pickup leg', /pickup/.test(r.nextText) && r.remainingM > 150 && r.remainingM < 230);
r = g.guideTick(st, { lat: 16.5009, lng: 80.6000 + 0.0019 }, route, D);
ok('arrival announced', r.arrived && /arrived/.test(r.say[0]));
r = g.guideTick(g.newGuideState(), { lat: 16.5009, lng: 80.6100 }, route, D);
ok('off route flagged for re-route', r.offRoute === true);
