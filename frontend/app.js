const chatScroll = document.getElementById("chatScroll");
const form = document.getElementById("composerForm");
const input = document.getElementById("messageInput");
const statusText = document.getElementById("statusText");
const statusDot = document.querySelector(".pulse-dot");
const languageSelect = document.getElementById("languageSelect");

const ticketPhotoInput = document.getElementById("ticketPhotoInput");
const imagePreview = document.getElementById("imagePreview");
const imagePreviewThumb = document.getElementById("imagePreviewThumb");
const imagePreviewName = document.getElementById("imagePreviewName");
const imagePreviewRemove = document.getElementById("imagePreviewRemove");

const micBtn = document.getElementById("micBtn");
const helpBtn = document.getElementById("helpBtn");
const helpModal = document.getElementById("helpModal");
const helpModalBody = document.getElementById("helpModalBody");
const helpModalClose = document.getElementById("helpModalClose");
const tourReplay = document.getElementById("tourReplay");
const tourOverlay = document.getElementById("tourOverlay");
const tourTitle = document.getElementById("tourTitle");
const tourBody = document.getElementById("tourBody");
const tourNext = document.getElementById("tourNext");
const tourSkip = document.getElementById("tourSkip");

let attachedImage = null; // { base64, mediaType, fileName }
let mapCounter = 0;

// ============================================================
// FEATURE: Full Offline Knowledge Base (RAG Without Network)
// -----------------------------------------------------------------------
// Silently caches the real KB articles (same 54 the online RAG searches)
// to localStorage whenever the backend is reachable, so if a later chat
// message can't reach /api/chat (no network), the chat itself can still
// answer FAQ/policy questions from real cached article text — plain
// keyword matching, not semantic search or an LLM-written answer (those
// need a live connection, so this is honestly labeled as offline mode
// whenever it's used, never presented as a normal AI reply).
// ============================================================
const OFFLINE_KB_KEY = "offlineKnowledgeBase";

async function primeOfflineKnowledgeBase() {
  try {
    const res = await fetch("/api/advanced/offline-knowledge-base");
    if (!res.ok) return;
    const data = await res.json();
    if (data.articles && data.articles.length) {
      localStorage.setItem(OFFLINE_KB_KEY, JSON.stringify(data.articles));
    }
  } catch { /* offline or backend down right now - fine, this just retries on next page load */ }
}
primeOfflineKnowledgeBase();

function searchOfflineKnowledgeBase(query) {
  let articles = [];
  try { articles = JSON.parse(localStorage.getItem(OFFLINE_KB_KEY)) || []; } catch { articles = []; }
  if (!articles.length || !query) return null;
  const q = query.toLowerCase();
  const words = q.split(/\W+/).filter((w) => w.length > 2);
  let best = null, bestScore = 0;
  articles.forEach((a) => {
    const haystack = `${a.category} ${a.text} ${(a.entities || []).join(" ")}`.toLowerCase();
    let score = 0;
    if (haystack.includes(q)) score += 5;
    words.forEach((w) => { if (haystack.includes(w)) score += 1; });
    if (score > bestScore) { bestScore = score; best = a; }
  });
  return bestScore > 0 ? best : null;
}


function renderMap(wrap, mapData) {
  if (!mapData) return;
  const mapId = `map-${++mapCounter}`;
  const outer = document.createElement("div");
  outer.className = "msg__map-wrap";
  const mapDiv = document.createElement("div");
  mapDiv.className = "msg__map";
  mapDiv.id = mapId;
  const caption = document.createElement("div");
  caption.className = "msg__map-caption";
  outer.appendChild(mapDiv);
  outer.appendChild(caption);
  wrap.appendChild(outer);

  if (mapData.trains && mapData.trains.length) {
    const list = document.createElement("ul");
    list.className = "msg__trains-list";
    mapData.trains.forEach((t) => {
      const li = document.createElement("li");
      const timing = [t.departure ? `dep ${t.departure}` : null, t.arrival ? `arr ${t.arrival}` : null]
        .filter(Boolean).join(" · ");
      li.innerHTML = `<strong>${escapeHtml(String(t.train_number))}</strong> ${t.train_name ? `— ${escapeHtml(t.train_name)}` : ""}${timing ? ` <span>(${escapeHtml(timing)})</span>` : ""}`;
      list.appendChild(li);
    });
    wrap.appendChild(list);
  }

  // Leaflet needs the div to be in the DOM with a real size before init,
  // so defer to the next frame.
  requestAnimationFrame(() => {
    if (typeof L === "undefined") {
      caption.textContent = "Map library failed to load.";
      return;
    }
    const map = L.map(mapId, { scrollWheelZoom: false });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 18,
    }).addTo(map);

    if (mapData.type === "live_position") {
      if (mapData.lat == null || mapData.lng == null) {
        caption.textContent = "No position could be determined for this train yet.";
        map.setView([22.5, 79], 5);
        return;
      }
      const marker = L.marker([mapData.lat, mapData.lng]).addTo(map);
      const label = [mapData.current_station, mapData.next_station ? `→ ${mapData.next_station}` : ""].filter(Boolean).join(" ");
      marker.bindPopup(`Train ${mapData.train_number}<br>${label}`).openPopup();
      map.setView([mapData.lat, mapData.lng], 7);

      const isEstimate = mapData.position_source === "estimated_from_last_station";
      const delayText = mapData.delay_minutes != null ? ` · delay ${formatDelayDuration(mapData.delay_minutes)}` : "";
      caption.innerHTML = isEstimate
        ? `<span class="estimate-flag">Estimated</span> from last known station (no live GPS fix from provider)${delayText}`
        : `Live position from data provider${delayText}`;
    } else if (mapData.type === "route") {
      const withCoords = (mapData.stations || []).filter((s) => s.lat != null && s.lng != null);
      if (!withCoords.length) {
        caption.textContent = "No station coordinates available to plot this route yet.";
        map.setView([22.5, 79], 5);
        return;
      }
      const latlngs = withCoords.map((s) => [s.lat, s.lng]);
      L.polyline(latlngs, { color: "#16324F", weight: 3 }).addTo(map);
      withCoords.forEach((s) => {
        L.circleMarker([s.lat, s.lng], { radius: 5, color: "#C1272D", fillColor: "#C1272D", fillOpacity: 1 })
          .addTo(map)
          .bindPopup(`${s.name} (${s.code})${s.scheduled_arrival ? `<br>Arr: ${s.scheduled_arrival}` : ""}${s.scheduled_departure ? `<br>Dep: ${s.scheduled_departure}` : ""}`);
      });
      map.fitBounds(latlngs, { padding: [20, 20] });

      const missing = (mapData.stations || []).length - withCoords.length;
      caption.textContent = missing > 0
        ? `Route for train ${mapData.train_number} — ${missing} stop(s) have no plotted coordinates yet`
        : `Full route for train ${mapData.train_number}`;
    } else if (mapData.type === "station_pair") {
      const points = [];
      if (mapData.source && mapData.source.lat != null) {
        const p = [mapData.source.lat, mapData.source.lng];
        points.push(p);
        L.marker(p).addTo(map).bindPopup(`${mapData.source.name} (${mapData.source.code})`);
      }
      if (mapData.dest && mapData.dest.lat != null) {
        const p = [mapData.dest.lat, mapData.dest.lng];
        points.push(p);
        L.marker(p).addTo(map).bindPopup(`${mapData.dest.name} (${mapData.dest.code})`);
      }
      if (!points.length) {
        caption.textContent = "No coordinates available for these stations yet.";
        map.setView([22.5, 79], 5);
        return;
      }
      if (points.length === 2) {
        L.polyline(points, { color: "#16324F", weight: 2, dashArray: "6 6" }).addTo(map);
        map.fitBounds(points, { padding: [30, 30] });
      } else {
        map.setView(points[0], 6);
      }
      caption.textContent = "Source/destination preview (approximate straight line, not the actual rail path or live position)";
    } else if (mapData.type === "nearby_stations") {
      const points = [];
      if (mapData.anchor && mapData.anchor.lat != null) {
        const p = [mapData.anchor.lat, mapData.anchor.lng];
        points.push(p);
        L.circleMarker(p, { radius: 7, color: "#C1272D", fillColor: "#C1272D", fillOpacity: 1 })
          .addTo(map)
          .bindPopup(`<strong>${escapeHtml(mapData.anchor.name)}</strong> (${escapeHtml(mapData.anchor.code)}) — anchor`)
          .openPopup();
      }
      (mapData.stations || []).forEach((s) => {
        if (s.lat == null) return;
        const p = [s.lat, s.lng];
        points.push(p);
        L.marker(p).addTo(map).bindPopup(`${escapeHtml(s.name)} (${escapeHtml(s.code)})<br>${s.distance_km} km away`);
      });
      if (!points.length) {
        caption.textContent = "No coordinates available to plot nearby stations.";
        map.setView([22.5, 79], 5);
        return;
      }
      if (points.length > 1) {
        map.fitBounds(points, { padding: [30, 30] });
      } else {
        map.setView(points[0], 7);
      }
      caption.textContent = `Nearby stations within ~${mapData.radius_km} km (great-circle distance, not rail distance)`;

      if (mapData.stations && mapData.stations.length) {
        const list = document.createElement("ul");
        list.className = "msg__trains-list";
        mapData.stations.forEach((s) => {
          const li = document.createElement("li");
          li.innerHTML = `<strong>${escapeHtml(s.name)}</strong> (${escapeHtml(s.code)}) <span>${s.distance_km} km away</span>`;
          list.appendChild(li);
        });
        wrap.appendChild(list);
      }
    } else if (mapData.type === "alternative_routes") {
      const palette = ["#16324F", "#C1272D", "#8a6d1f"];
      const allPoints = [];
      (mapData.routes || []).forEach((route, i) => {
        const latlngs = route.stations.filter((s) => s.lat != null).map((s) => [s.lat, s.lng]);
        if (latlngs.length < 2) return;
        allPoints.push(...latlngs);
        L.polyline(latlngs, { color: palette[i % palette.length], weight: i === 0 ? 4 : 2, dashArray: i === 0 ? null : "6 6" }).addTo(map);
        route.stations.forEach((s) => {
          if (s.lat == null) return;
          L.circleMarker([s.lat, s.lng], { radius: 4, color: palette[i % palette.length], fillColor: palette[i % palette.length], fillOpacity: 1 })
            .addTo(map)
            .bindPopup(`${escapeHtml(s.name)} (${escapeHtml(s.code)})<br>Route ${i + 1}`);
        });
      });
      if (!allPoints.length) {
        caption.textContent = "No plottable route found in the curated trunk-route network.";
        map.setView([22.5, 79], 5);
        return;
      }
      map.fitBounds(allPoints, { padding: [20, 20] });
      caption.textContent = "Curated trunk-corridor graph paths (real distances, simplified network) — confirm actual trains per leg separately";

      if (mapData.routes && mapData.routes.length) {
        const list = document.createElement("ul");
        list.className = "msg__trains-list";
        mapData.routes.forEach((route, i) => {
          const li = document.createElement("li");
          const via = route.stations.map((s) => s.code).join(" → ");
          const tag = route.is_direct_corridor ? "direct corridor" : `${route.hops} change(s)`;
          li.innerHTML = `<strong>Option ${i + 1}:</strong> ${escapeHtml(via)} <span>${route.distance_km} km · ${tag}</span>`;
          list.appendChild(li);
        });
        wrap.appendChild(list);
      }
    }
  });
}

function addMessage({ role, html, sources, diagrams, ragTrace, mapData }) {
  const wrap = document.createElement("div");
  wrap.className = `msg msg--${role}`;

  const label = document.createElement("div");
  label.className = "msg__label";
  label.textContent = role === "user" ? "YOU" : "ENQUIRY DESK";

  const bubble = document.createElement("div");
  bubble.className = "msg__bubble";
  bubble.innerHTML = html;

  wrap.appendChild(label);
  wrap.appendChild(bubble);

  if (diagrams && diagrams.length) {
    const diagWrap = document.createElement("div");
    diagWrap.className = "msg__diagrams";
    diagrams.forEach((d) => {
      const fig = document.createElement("figure");
      fig.className = "msg__diagram";
      const img = document.createElement("img");
      img.src = d.url;
      img.alt = d.label;
      const cap = document.createElement("figcaption");
      cap.textContent = d.label;
      fig.appendChild(img);
      fig.appendChild(cap);
      diagWrap.appendChild(fig);
    });
    wrap.appendChild(diagWrap);
  }

  if (mapData) {
    renderMap(wrap, mapData);
  }

  if (sources && sources.length) {
    const src = document.createElement("div");
    src.className = "msg__sources";
    let text = `Grounded on: ${sources.join(", ")}`;
    if (ragTrace) {
      const bits = [];
      if (ragTrace.used_broadened_search) bits.push("broadened search");
      if (ragTrace.used_graph_expansion) bits.push(`graph-expanded (${(ragTrace.graph_matched_entities || []).join(", ")})`);
      if (bits.length) text += ` · ${bits.join(" · ")}`;
    }
    src.textContent = text;
    wrap.appendChild(src);
  }

  chatScroll.appendChild(wrap);
  chatScroll.scrollTop = chatScroll.scrollHeight;
  return wrap;
}

function addLoadingBubble() {
  const wrap = document.createElement("div");
  wrap.className = "msg msg--assistant msg--loading";
  wrap.innerHTML = `
    <div class="msg__label">ENQUIRY DESK</div>
    <div class="msg__bubble">
      <span class="dot-flash"></span><span class="dot-flash"></span><span class="dot-flash"></span>
    </div>`;
  chatScroll.appendChild(wrap);
  chatScroll.scrollTop = chatScroll.scrollHeight;
  return wrap;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Labels the live "Avg. running speed" figure with WHERE it came from,
// same honesty pattern as the "(Moderate confidence, ML estimate)" tag
// already used for predicted_delay_minutes above. "railkit"/"railradar"/
// "railkit+railradar_avg" = a real measurement from one or both providers
// (shown unlabeled, same as before); "railradar_live_gps" = RailRadar's
// own live GPS speed reading; "ml_estimate" = neither provider had real
// distance/time data yet, so this is an ML instant estimate, not a
// measurement — must say so rather than looking like a real reading.
function formatAvgSpeedSourceTag(source) {
  if (source === "railradar_live_gps") return " (live GPS reading)";
  if (source === "distance_delta_per_ping") return " (per-ping distance calc)";
  if (source === "ml_estimate") return " (ML estimate)";
  return "";
}

function clearAttachedImage() {
  attachedImage = null;
  ticketPhotoInput.value = "";
  imagePreview.hidden = true;
  imagePreviewThumb.src = "";
  imagePreviewName.textContent = "";
}

ticketPhotoInput.addEventListener("change", () => {
  const file = ticketPhotoInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result; // "data:image/jpeg;base64,...."
    const [meta, base64] = dataUrl.split(",");
    const mediaType = meta.match(/data:(.*);base64/)[1];
    attachedImage = { base64, mediaType, fileName: file.name };
    imagePreviewThumb.src = dataUrl;
    imagePreviewName.textContent = file.name;
    imagePreview.hidden = false;
  };
  reader.readAsDataURL(file);
});

imagePreviewRemove.addEventListener("click", clearAttachedImage);

async function sendMessage(message) {
  const userHtmlParts = [escapeHtml(message)];
  if (attachedImage) {
    userHtmlParts.push(`<div class="msg__attachment">📷 ${escapeHtml(attachedImage.fileName)}</div>`);
  }
  addMessage({ role: "user", html: userHtmlParts.join("") });
  const loadingEl = addLoadingBubble();

  const payload = { message, language: languageSelect ? languageSelect.value : "auto" };
  if (attachedImage) {
    payload.image_base64 = attachedImage.base64;
    payload.image_media_type = attachedImage.mediaType;
  }
  clearAttachedImage();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    loadingEl.remove();
    addMessage({
      role: "assistant",
      html: escapeHtml(data.answer).replace(/\n/g, "<br>"),
      sources: data.sources,
      diagrams: data.diagrams,
      ragTrace: data.rag_trace,
      mapData: data.map,
    });
    speakAnswer(data.answer);
  } catch (err) {
    loadingEl.remove();
    const offlineMatch = searchOfflineKnowledgeBase(message);
    if (offlineMatch) {
      addMessage({
        role: "assistant",
        html: `🔌 <em>No network reached — answering from a cached FAQ article, not a live AI-generated answer.</em><br><br><strong>${escapeHtml(offlineMatch.category)}</strong><br>${escapeHtml(offlineMatch.text).replace(/\n/g, "<br>")}`,
      });
    } else {
      addMessage({
        role: "assistant",
        html: "I couldn't reach the backend just now, and no cached offline FAQ article matched this question closely enough. Please check the server is running and try again.",
      });
    }
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const message = input.value.trim();
  if (!message && !attachedImage) return;
  input.value = "";
  sendMessage(message);
});

// Simple backend health probe so the header reflects real connectivity,
// not a hardcoded "online" badge.
async function checkHealth() {
  try {
    const res = await fetch("/api/health");
    if (res.ok) {
      statusText.textContent = "DATA LINK ACTIVE";
      statusDot.classList.add("online");
    } else {
      throw new Error("bad status");
    }
  } catch {
    statusText.textContent = "DATA LINK UNREACHABLE";
    statusDot.classList.add("offline");
  }
}

checkHealth();

// ============================================================
// FEATURE: Voice Assistant Integration
// ============================================================
// Uses the browser-native Web Speech API - no external service, no key,
// works offline-ish (recognition still needs the browser's speech backend,
// but there's no server-side voice pipeline to build or pay for). Not every
// browser supports it (notably: no SpeechRecognition in Firefox as of
// writing), so the mic button quietly disables itself instead of throwing
// errors at people on unsupported browsers.
const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
let isListening = false;

// Multi-Language Support: reuse the same dropdown selection for voice
// input/output, since the Web Speech API also needs a BCP-47 locale.
const LANGUAGE_BCP47 = {
  auto: "en-IN", English: "en-IN", Hindi: "hi-IN", Bengali: "bn-IN", Tamil: "ta-IN",
  Telugu: "te-IN", Kannada: "kn-IN", Malayalam: "ml-IN", Marathi: "mr-IN",
  Gujarati: "gu-IN", Punjabi: "pa-IN", Odia: "or-IN",
};
function currentVoiceLocale() {
  const choice = languageSelect ? languageSelect.value : "auto";
  return LANGUAGE_BCP47[choice] || "en-IN";
}

if (SpeechRecognitionAPI) {
  recognizer = new SpeechRecognitionAPI();
  recognizer.lang = currentVoiceLocale();
  recognizer.interimResults = false;
  recognizer.maxAlternatives = 1;

  recognizer.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    input.value = transcript;
    sendMessage(transcript);
  };
  recognizer.onerror = () => {
    isListening = false;
    micBtn.classList.remove("listening");
  };
  recognizer.onend = () => {
    isListening = false;
    micBtn.classList.remove("listening");
  };

  micBtn.addEventListener("click", () => {
    if (isListening) {
      recognizer.stop();
      return;
    }
    recognizer.lang = currentVoiceLocale();
    isListening = true;
    micBtn.classList.add("listening");
    recognizer.start();
  });
} else {
  micBtn.disabled = true;
  micBtn.title = "Voice input isn't supported in this browser";
  micBtn.style.opacity = "0.4";
  micBtn.style.cursor = "not-allowed";
}

function speakAnswer(text) {
  const toggle = document.getElementById("voiceReplyToggle");
  if (!toggle || !toggle.checked) return;
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel(); // don't stack utterances if replies come fast
  const utterance = new SpeechSynthesisUtterance(text.replace(/[•\u2022]/g, ""));
  utterance.lang = currentVoiceLocale();
  utterance.rate = 1.0;
  window.speechSynthesis.speak(utterance);
}

// ============================================================
// FEATURE: Smart Help & Tutorial System
// ============================================================

async function openHelpModal() {
  helpModal.hidden = false;
  helpModalBody.innerHTML = "<p>Loading…</p>";
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "help" }),
    });
    const data = await res.json();
    // The backend's help answer uses **bold** and bullet lines; render it
    // a little more richly than the plain chat bubble does.
    const html = escapeHtml(data.answer)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\n/g, "<br>");
    helpModalBody.innerHTML = `<div class="help-item">${html}</div>`;
  } catch {
    helpModalBody.innerHTML = "<p>Couldn't load help content — check the server is running.</p>";
  }
}

helpBtn.addEventListener("click", openHelpModal);
helpModalClose.addEventListener("click", () => { helpModal.hidden = true; });
helpModal.addEventListener("click", (e) => { if (e.target === helpModal) helpModal.hidden = true; });

// --- Onboarding tour: shown once per browser, replayable from the help modal ---
const TOUR_STEPS = [
  { title: "Welcome aboard 👋", body: "This is a free-text railway assistant — type naturally, no fixed menu." },
  { title: "📷 Attach a ticket photo", body: "Instead of typing your PNR, tap the photo icon and attach a picture of your ticket." },
  { title: "🎙️ Ask by voice", body: "Tap the mic icon and just speak your question. Turn on \"Speak answers aloud\" to hear replies too." },
  { title: "🗺️ Live maps", body: "Ask to track a train, see its route, find nearby stations, or plan an alternative route — an interactive map appears right in the chat." },
  { title: "🚉 New: nearby stations & alternative routes", body: "Try \"stations near NDLS\" or \"alternative route from NDLS to MAS\" for graph-based route suggestions." },
  { title: "🧑‍🤝‍🧑 New: crowd prediction", body: "Ask \"how crowded will train 12951 be\" for a booking-data-based estimate — always labelled as an estimate, never a live sensor reading." },
  { title: "🌐 Multi-language", body: "Pick a language from the dropdown in the header, or just type in Hindi/Tamil/etc. and I'll detect it and reply in kind." },
  { title: "📡🔍📊 New: the header toolbar", body: "Live Tracking (auto-updating WebSocket feed with a live delay chart for that train), Station Search (semantic + geo-coded), and an Analytics Dashboard — all one tap away." },
  { title: "❓ Need a reminder?", body: "Tap the ? button in the header any time to see this again." },
];
let tourStep = 0;

function showTourStep() {
  const step = TOUR_STEPS[tourStep];
  tourTitle.textContent = step.title;
  tourBody.textContent = step.body;
  tourNext.textContent = tourStep === TOUR_STEPS.length - 1 ? "Got it" : "Next →";
}

function startTour() {
  tourStep = 0;
  showTourStep();
  tourOverlay.hidden = false;
}

function endTour() {
  tourOverlay.hidden = true;
  try { localStorage.setItem("railwayAssistantTourSeen", "1"); } catch {}
}

tourNext.addEventListener("click", () => {
  tourStep += 1;
  if (tourStep >= TOUR_STEPS.length) {
    endTour();
  } else {
    showTourStep();
  }
});
tourSkip.addEventListener("click", endTour);
tourReplay.addEventListener("click", () => {
  helpModal.hidden = true;
  startTour();
});

// Show the tour once per browser. If localStorage is unavailable
// (privacy mode etc.), fail open and just show it every time rather than
// crashing the page.
let alreadySeenTour = false;
try { alreadySeenTour = localStorage.getItem("railwayAssistantTourSeen") === "1"; } catch {}
if (!alreadySeenTour) {
  startTour();
}

// ============================================================
// FEATURE: Real-Time Train Position via WebSockets
// FEATURE: Semantic Station Search with Geo-Coding
// FEATURE: Train Delay Prediction (ML Model) — surfaced inside Live Track,
//          which also charts that specific train's delay history live
// FEATURE: Advanced Charting & Analytics Dashboard
// ============================================================
(function () {
  const WS_BASE = (location.protocol === "https:" ? "wss://" : "ws://") + location.host;

  function setStatus(el, text, kind) {
    el.textContent = text;
    el.classList.remove("is-live", "is-error");
    if (kind) el.classList.add(kind);
  }

  // NOTE: this file is actually two separate top-level IIFEs (this one,
  // and a second one further down that defines the app's OWN postJSON
  // helper alongside the Firebase/push code) — a plain top-level const/
  // function in one isn't visible in the other. This local copy is
  // deliberately duplicated rather than shared, for the new features
  // added to THIS IIFE (Background-surviving Smart Alarm, Connection-Risk
  // Alert, Real-Time Per-Coach Crowding, End-of-Trip Summary) that need a
  // small POST-JSON helper here.
  async function ltPostJSON(url, body) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return res.json();
  }

  function wireModal(btn, modal, closeBtn, onOpen) {
    if (!btn || !modal) return;
    btn.addEventListener("click", () => {
      modal.hidden = false;
      if (onOpen) onOpen();
    });
    closeBtn.addEventListener("click", () => { modal.hidden = true; });
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.hidden = true; });
  }

  // -------------------------------------------------------------
  // FEATURE: Real-Time Train Position via WebSockets
  // -------------------------------------------------------------
  const liveTrackBtn = document.getElementById("liveTrackBtn");
  const liveTrackModal = document.getElementById("liveTrackModal");
  const liveTrackClose = document.getElementById("liveTrackClose");
  const liveTrackForm = document.getElementById("liveTrackForm");
  const liveTrackInput = document.getElementById("liveTrackInput");
  const liveTrackStatus = document.getElementById("liveTrackStatus");
  const liveTrackCaption = document.getElementById("liveTrackCaption");
  const liveTrackStats = document.getElementById("liveTrackStats");
  const liveTrackTimeline = document.getElementById("liveTrackTimeline");
  // REDESIGN: RailYatri-style "Next: <station> in <eta> (<delay>)" bar —
  // shows/hides in lockstep with the full stat table below (liveTrackStats)
  // and shares its ltNextStation/ltNextEta/ltDelay child elements.
  const liveTrackQuickBar = document.getElementById("liveTrackQuickBar");

  let liveTrackSocket = null;
  // FEATURE: auto-reconnect for the live-tracking WebSocket. Previously,
  // if the connection dropped for any reason (network blip, a proxy's
  // idle timeout, a backend restart), the UI just sat on its last-received
  // data forever with no further updates until the user noticed and
  // manually clicked Track again - looking exactly like "nothing updates
  // except the clock" if a drop happened moments after connecting.
  // `liveTrackWantsConnection` distinguishes a genuinely wanted, still-open
  // tracking session (auto-reconnect) from the user deliberately closing
  // the modal/switching trains (don't reconnect into nothing).
  let liveTrackWantsConnection = false;
  let liveTrackReconnectAttempts = 0;
  let liveTrackReconnectTimer = null;
  let liveTrackMap = null;
  let liveTrackMarker = null;
  let liveTrackRouteLayer = null;
  let liveTrackRouteBoundsFit = false;
  let liveTrackChart = null;
  let liveTrackedTrainNumber = null;
  // Explainable AI + Crowd-Sourced Positions, overlaid on THIS live map —
  // see the handlers wired below liveTrackForm's submit listener.
  let lastKnownDelayMinutes = null;
  let ltCrowdMarker = null;
  let ltCrowdCircle = null;
  let ltCrowdOverlayEnabled = false;
  // FEATURE: Crowd-Sourced Train Position — mobile-first GPS. Persists
  // across tracked trains within this session (once a passenger opts in,
  // they probably want it on for whichever train they track next too);
  // ltSharePromptHandledForTrain just stops the proactive prompt from
  // re-asking for the SAME train number after it's already been answered.
  let ltShareMyPositionEnabled = false;
  let ltShareIntervalId = null;
  let ltSharePromptHandledForTrain = null;
  const LT_SHARE_INTERVAL_MS = 30000;

  // Real per-halt distance-from-origin (RailRadar), keyed by station code —
  // fetched once per tracked train and used ONLY as a fallback for stations
  // where RailKit's own distance_km is missing. Never invented: a code
  // with no entry here (and no RailKit distance) just shows nothing, same
  // as before this fallback existed.
  let liveTrackRouteStatsByCode = {};
  let liveStatusAsOfTicker = null;

  // FEATURE: a small live delay-trend sparkline — rolling buffer of the
  // last ~20 polls' delay figure (predicted, falling back to reported),
  // reset whenever a new train starts tracking. Distinct from the big
  // per-station bar chart (that one is PER-STATION history across the
  // whole route; this is "is the number moving up or down RIGHT NOW").
  let ltDelaySparkline = [];
  const LT_SPARKLINE_MAX_POINTS = 20;

  // FEATURE: End-of-Trip Summary Card — which (trainNumber, date) this
  // session has already built/shown a summary for, so it's only offered
  // once per completed journey, not re-triggered on every subsequent poll
  // after the train has reached its destination.
  let ltTripSummaryShownKey = null;

  // FEATURE: Real-Time Per-Coach Crowding — periodic refresh of the
  // aggregated per-coach list, independent of the websocket's own 5s
  // cadence (crowding changes slower than position/delay).
  let ltCoachCrowdIntervalId = null;
  const LT_COACH_CROWD_REFRESH_MS = 20000;

  // FEATURE: Lite/Text-Only Tracking Mode — persists across trains within
  // this session (same reasoning as ltShareMyPositionEnabled above).
  let ltLiteModeOn = false;

  // FEATURE: "Smart Alarm" — Dynamic Departure Reminder, and Station
  // Navigator / Catering deep-links — all need the real current/next
  // station CODE (not just the display name shown in the stats grid),
  // refreshed every live-tracking tick alongside everything else above.
  let ltCurrentStationCode = null;
  let ltNextStationCode = null;
  let ltAlarmIntervalId = null;
  // FEATURE: Background-surviving Smart Alarm — whether the CURRENTLY
  // armed alarm also registered a server-side push watch (see
  // /api/push/alarms + alert_scheduler.py). Only an explicit "Cancel
  // Alarm" click clears the server-side registration too — switching
  // tracked trains does NOT, since a background alarm surviving exactly
  // that kind of foreground change is the whole point of this feature.
  let ltAlarmBackgroundActive = false;
  let ltAlarmFired = false;
  let ltAlarmPreciseTimeoutId = null;
  const LT_ALARM_POLL_MS = 30000;

  // Schedules a precise wake-up for the exact real-time moment
  // (alarmAtIso, computed server-side from RailKit's live ETA) the alarm
  // should fire, measured against THIS DEVICE's own system clock —
  // instead of only waiting for the next 30s poll to happen to notice
  // "alarm_now" has flipped true, which can leave the notification firing
  // up to LT_ALARM_POLL_MS late. Re-armed on every poll since a changing
  // delay shifts alarmAtIso; harmless if it fires a few seconds early —
  // the immediate re-check below confirms against the live data before
  // actually notifying.
  function scheduleLtAlarmPrecise(alarmAtIso, onDue) {
    if (ltAlarmPreciseTimeoutId) { clearTimeout(ltAlarmPreciseTimeoutId); ltAlarmPreciseTimeoutId = null; }
    if (!alarmAtIso) return;
    const dueAt = new Date(alarmAtIso).getTime();
    if (Number.isNaN(dueAt)) return;
    const msUntilDue = dueAt - Date.now();
    if (msUntilDue <= 0) { onDue(); return; }
    // Browsers cap a single setTimeout's effective delay handling fine
    // up to well beyond any realistic lead time here, so one direct
    // timeout (no chunking) is enough for this use case.
    ltAlarmPreciseTimeoutId = setTimeout(onDue, msUntilDue);
  }

  async function loadLiveTrackRouteStats(trainNumber) {
    liveTrackRouteStatsByCode = {};
    const avgDistEl = document.getElementById("ltAvgDistanceBetweenHalts");
    const avgTimeEl = document.getElementById("ltAvgTimeBetweenHalts");
    const basisEl = document.getElementById("ltRouteStatsBasis");
    if (avgDistEl) avgDistEl.textContent = "—";
    if (avgTimeEl) avgTimeEl.textContent = "—";
    if (basisEl) basisEl.hidden = true;
    try {
      const res = await fetch(`/api/train/${encodeURIComponent(trainNumber)}/route-stats`);
      const data = await res.json();
      if (data && data.available && Array.isArray(data.stops)) {
        data.stops.forEach((s) => {
          if (s.code && s.distance_from_origin_km != null) {
            liveTrackRouteStatsByCode[s.code] = s.distance_from_origin_km;
          }
        });
      }
      if (data && data.available) {
        if (avgDistEl) {
          avgDistEl.textContent = data.avg_distance_km_between_halts != null
            ? `${data.avg_distance_km_between_halts} km` : "—";
        }
        if (avgTimeEl) {
          avgTimeEl.textContent = data.avg_time_minutes_between_halts != null
            ? `${data.avg_time_minutes_between_halts} min` : "—";
        }
        if (basisEl && data.basis) {
          basisEl.textContent = `Why: ${data.basis}`;
          basisEl.hidden = false;
        }
      } else if (data && data.note && basisEl) {
        // Surfaces the REAL reason (bad key, train not found, rate limit,
        // network error) instead of just leaving the fields blank with no
        // explanation — see backend's railradar_fallback.get_last_error().
        basisEl.textContent = `RailRadar: ${data.note}`;
        basisEl.hidden = false;
      }
    } catch {
      // Best-effort fallback only — RailKit's own distance display (if any)
      // still works fine without this.
    }
  }

  // Real distance-from-origin for a station: prefers RailKit's own
  // distance_km, falls back to the RailRadar figure fetched above.
  function resolvedDistanceKm(s) {
    if (s.distance_km != null && s.distance_km !== "") return s.distance_km;
    if (s.code && liveTrackRouteStatsByCode[s.code] != null) return liveTrackRouteStatsByCode[s.code];
    return null;
  }

  // Custom train-icon marker (frontend/assets/icons/train-marker.png) used
  // for the live GPS position on the tracking map, in place of Leaflet's
  // generic pin — makes the moving train instantly recognizable on the map,
  // the way IRCTC's own running-status map does. Kept small (26x19) so it
  // doesn't dominate the map at typical zoom levels.
  const TRAIN_ICON_SIZE = [26, 19];
  const TRAIN_ICON_ANCHOR = [13, 9.5];
  function buildTrainMarkerIcon() {
    if (typeof L === "undefined") return null;
    return L.icon({
      iconUrl: "assets/icons/train-marker.png",
      iconSize: TRAIN_ICON_SIZE,
      iconAnchor: TRAIN_ICON_ANCHOR,
      popupAnchor: [0, -9],
      className: "train-marker-icon",
    });
  }
  const trainMarkerIcon = buildTrainMarkerIcon();

  // FEATURE: direction-aware marker rotation. The backend auto-detects
  // whether the tracked train is running UP or DOWN (see
  // gps_tracking.determine_train_direction — based on the odd/even train
  // number convention) and sends it as data.direction on every tick. We
  // mirror the icon horizontally to face the correct way rather than
  // literally spinning it upside down: DOWN trains get flipped 180°
  // (scaleX(-1)) so they face left, UP trains render at their natural
  // orientation (facing right) — a stable left/right cue regardless of the
  // current map pan/zoom, without needing real compass bearing data.
  function applyTrainMarkerDirection(direction) {
    if (!liveTrackMarker || typeof liveTrackMarker.getElement !== "function") return;
    const el = liveTrackMarker.getElement();
    if (!el) return;
    const img = el.tagName === "IMG" ? el : el.querySelector("img");
    if (!img) return;
    img.style.transform = direction === "DOWN" ? "rotate(180deg)" : "rotate(0deg)";
    img.style.transformOrigin = "50% 50%";
  }

  function ensureLiveTrackMap() {
    if (liveTrackMap || typeof L === "undefined") return;
    liveTrackMap = L.map("liveTrackMap", { scrollWheelZoom: false }).setView([22.5, 79], 5);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors", maxZoom: 18,
    }).addTo(liveTrackMap);
  }

  // FEATURE: Per-Station Delay Chart — a grouped/double bar chart scoped to
  // whichever ONE train the user is currently tracking. X axis is every
  // real stopping station on this run (not time-of-day), with two bars per
  // station:
  //   - "Actual delay (min)": RailKit's own recorded arrival.delay_minutes,
  //     shown ONLY once the train has genuinely arrived there — never the
  //     "reconciled" stand-in value timingRow()/predictedDelayBadge() use
  //     for not-yet-reached stations (see arrival.actual_is_predicted).
  //     Upcoming stations render as a gap (null), not a 0-min bar.
  //   - "Expected delay (min)": the same per-station ML/heuristic estimate
  //     already shown in the stop timeline above (predicted_delay_minutes —
  //     see backend's _predict_delay_per_reporting_station), so you can see
  //     prediction vs. reality for stations already reached, and just the
  //     prediction for ones still ahead.
  // Rebuilt from the live `timeline` array on every WebSocket tick (see
  // updateLiveTrackChartFromTimeline, called from socket.onmessage) rather
  // than a separate history endpoint — the per-station timeline is already
  // the one source of truth driving the stop-by-stop list, so the chart
  // never disagrees with it. Intermediate (non-stoppage, GPS-only) points
  // are left out, same "kind !== 'intermediate'" real-station convention
  // used elsewhere (e.g. drawLiveTrackRoute, the covered-stops list).
  function stationChartSeriesFromTimeline(timelineFlat) {
    const stations = (Array.isArray(timelineFlat) ? timelineFlat : [])
      .filter((s) => s && s.name && s.kind !== "intermediate");
    const labels = stations.map((s) => s.name);
    const actual = stations.map((s) =>
      (s.arrival && s.arrival.delay_minutes != null && !s.arrival.actual_is_predicted) ? s.arrival.delay_minutes : null
    );
    const expected = stations.map((s) => (s.predicted_delay_minutes != null ? s.predicted_delay_minutes : null));
    return { labels, actual, expected };
  }

  function initLiveTrackChart(trainNumber) {
    if (typeof Chart === "undefined") return;
    const ctx = document.getElementById("liveTrackChart");
    if (liveTrackChart) { liveTrackChart.destroy(); liveTrackChart = null; }

    liveTrackChart = new Chart(ctx, {
      type: "bar",
      data: {
        labels: [],
        datasets: [
          { label: "Actual delay (min)", data: [], backgroundColor: "#C1272D" },
          { label: "Expected delay (min)", data: [], backgroundColor: "#FFB300" },
        ],
      },
      options: {
        animation: false,
        scales: {
          y: { beginAtZero: true, title: { display: true, text: "Delay (min)" } },
          x: { ticks: { autoSkip: false, maxRotation: 60, minRotation: 30 } },
        },
        plugins: { title: { display: true, text: `Train ${trainNumber} — delay by station` } },
      },
    });
  }

  // Called every WebSocket tick (see socket.onmessage) with the same flat
  // per-station `timeline` array passed to renderLiveTimeline, so the chart
  // always reflects the latest real/predicted figures with no extra fetch.
  function updateLiveTrackChartFromTimeline(timelineFlat) {
    if (!liveTrackChart) return;
    const { labels, actual, expected } = stationChartSeriesFromTimeline(timelineFlat);
    liveTrackChart.data.labels = labels;
    liveTrackChart.data.datasets[0].data = actual;
    liveTrackChart.data.datasets[1].data = expected;
    liveTrackChart.update();
  }

  // HTML <input type="date"> gives "YYYY-MM-DD"; the backend/RailKit expect
  // "DD-MM-YYYY" everywhere — convert once here rather than at each call site.
  function toDDMMYYYY(isoDate) {
    if (!isoDate) return "";
    const [y, m, d] = isoDate.split("-");
    return y && m && d ? `${d}-${m}-${y}` : "";
  }

  function renderCrowd({ level, score, basis, disclaimer, seatDataError }) {
    const crowdStatus = document.getElementById("crowdStatus");
    const crowdResult = document.getElementById("crowdResult");
    const crowdLevel = document.getElementById("crowdLevel");
    const crowdBasisList = document.getElementById("crowdBasisList");
    const crowdDisclaimer = document.getElementById("crowdDisclaimer");
    if (!level) return;
    setStatus(
      crowdStatus,
      seatDataError
        ? `Estimate uses date/class/time patterns only — real booking-data lookup failed: ${seatDataError}`
        : "Estimate based on real booking data plus documented travel patterns.",
      seatDataError ? "is-error" : "is-live",
    );
    crowdResult.hidden = false;
    const levelSlug = level.toLowerCase().replace(/\s+/g, "-");
    crowdLevel.className = `crowd-result__level crowd-result__level--${levelSlug}`;
    crowdLevel.textContent = `${level} (score ${score}/100)`;
    crowdBasisList.innerHTML = "";
    (basis || []).forEach((b) => {
      const li = document.createElement("li");
      li.innerHTML = `<span>${escapeHtml(b)}</span>`;
      crowdBasisList.appendChild(li);
    });
    crowdDisclaimer.textContent = disclaimer || "";
  }

  // FEATURE: full IRCTC-style running-status list — every station RailKit
  // reports for this run (scheduled halts AND the small intermediate
  // stations the train only passes through), each with expected
  // (scheduled/predicted) vs actual arrival AND departure. Never invents a
  // time: any field the provider didn't supply for that stop renders as
  // "—" rather than a guess.
  function fmtTime(t) {
    return t ? escapeHtml(String(t)) : "—";
  }

  // FEATURE: show delay durations as "1h 10m" once they cross an hour,
  // instead of raw minutes ("70m") — matches how a person actually reads a
  // delay figure, and keeps a big number like VSKP's from reading as an
  // undifferentiated wall of digits. Purely a display transform: every
  // value stored, sent to the backend, or compared numerically elsewhere
  // still uses plain minutes untouched — only the rendered text changes.
  // A function declaration (not const) so it's hoisted and usable from
  // code earlier in this same scope (e.g. the live-position map caption).
  function formatDelayDuration(mins) {
    if (mins == null || Number.isNaN(mins)) return null;
    const sign = mins < 0 ? "-" : "";
    const abs = Math.round(Math.abs(mins));
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    if (h === 0) return `${sign}${m}m`;
    if (m === 0) return `${sign}${h}h`;
    return `${sign}${h}h ${m}m`;
  }

  function timingRow(label, timing) {
    if (!timing) return "";
    const hasAny = timing.scheduled || timing.expected || timing.actual;
    if (!hasAny) return "";
    const delayBadge = timing.delay_minutes != null
      ? `<span class="live-timeline__delay ${timing.delay_minutes > 0 ? "is-late" : timing.delay_minutes < 0 ? "is-early" : "is-ontime"}">${timing.delay_minutes > 0 ? "+" : ""}${formatDelayDuration(timing.delay_minutes)}</span>`
      : "";
    // BUGFIX: for upcoming stations, "Act"/delay here are now the SAME
    // reconciled figures as the predicted-delay badge below (see backend's
    // _predict_delay_per_reporting_station) instead of RailKit's own,
    // separately-updated predicted value — no more two disagreeing
    // numbers for the same station. Labelled "(predicted)" so it's never
    // mistaken for a real recorded arrival/departure.
    const actLabel = timing.actual_is_predicted ? "Act (predicted)" : "Act";
    return `
      <div class="live-timeline__timing">
        <span class="live-timeline__timing-label">${label}</span>
        <span class="live-timeline__timing-vals">
          <span title="Expected">Exp ${fmtTime(timing.expected || timing.scheduled)}</span>
          <span title="${timing.actual_is_predicted ? "Model-predicted, not yet actually recorded" : "Actual"}">${actLabel} ${fmtTime(timing.actual)}</span>
          ${delayBadge}
        </span>
      </div>`;
  }

  // RailYatri-style predicted-delay badge for an upcoming (not-yet-reached)
  // reporting station — backend's _predict_delay_per_reporting_station.
  function predictedDelayBadge(s) {
    if (s.predicted_delay_minutes == null) return "";
    const cls = s.predicted_delay_minutes > 0 ? "is-late" : "is-ontime";
    const hasBand = s.predicted_delay_low_minutes != null && s.predicted_delay_high_minutes != null;
    const bandText = hasBand ? ` (${formatDelayDuration(s.predicted_delay_low_minutes)}\u2013${formatDelayDuration(s.predicted_delay_high_minutes)})` : "";
    const etaText = s.predicted_eta ? ` · ETA ~${escapeHtml(s.predicted_eta)}` : "";
    // FEATURE: cross-method agreement tag - when the ML ensemble, the
    // trend/speed/weather heuristic, and the real actual-vs-expected
    // arithmetic all land close together (independently, not the same
    // number restated), that's a genuinely higher-confidence prediction
    // and gets flagged as such. There's no live API for other apps'
    // numbers to compare against directly - this is the honest, buildable
    // alternative: agreement across OUR OWN independently-computed methods.
    const isVeryHigh = s.predicted_delay_confidence === "Very High";
    const verified = isVeryHigh
      ? `<span class="live-timeline__verified" title="${s.prediction_methods_compared || 0} independent methods agreed within ${s.prediction_agreement_minutes} min">✓ cross-verified</span>`
      : "";
    return `<span class="live-timeline__predicted ${cls}" title="Estimated, ${escapeHtml(s.predicted_delay_confidence || "?")} confidence">
      ~${formatDelayDuration(s.predicted_delay_minutes)}${bandText} late (predicted)${etaText} ${verified}
    </span>`;
  }

  // "As of N mins ago" — best-effort, computed against the browser's own
  // clock vs. the server's status_updated_at timestamp (both the app
  // server and the browser are expected to be on the same machine/LAN for
  // this project, same honesty-scoped assumption as elsewhere here).
  function formatAsOfAgo(iso) {
    if (!iso) return "just now";
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return "just now";
    const diffMin = Math.max(0, Math.round((Date.now() - then) / 60000));
    if (diffMin < 1) return "less than a min ago";
    return `${diffMin} min${diffMin === 1 ? "" : "s"} ago`;
  }

  // Tap-the-train-icon status popup (RailYatri-style "Reached X~ / Crossed
  // X~ ... Report Inaccuracy"). `meta` is the top-level payload fields the
  // per-station timeline entry itself doesn't carry (current_station_kind,
  // status_response_id, etc.) — see app.py's /ws/track handler.
  function statusPopupHtml(s, meta, coveredStops) {
    if (!meta) return "";
    const verb = meta.current_station_kind === "intermediate" ? "Crossed" : "Reached";
    const haltText = meta.current_station_halt_minutes != null && meta.current_station_halt_minutes !== ""
      ? `Halt: ${escapeHtml(String(meta.current_station_halt_minutes))} min` : "";
    const delayText = meta.delay_minutes != null
      ? `<span class="live-timeline__status-delay ${meta.delay_minutes > 0 ? "is-late" : "is-ontime"}">${meta.delay_minutes > 0 ? formatDelayDuration(meta.delay_minutes) + " late" : "On time"}</span>`
      : "";
    // Real distance travelled so far — RailKit's distance_km for this
    // station if it has one, else the RailRadar fallback (see
    // resolvedDistanceKm). Never invented: omitted entirely if neither
    // source has a real number for this station.
    const distKm = resolvedDistanceKm(s);
    const distanceText = distKm != null
      ? `<div class="live-timeline__status-distance">Total distance covered: ${escapeHtml(String(distKm))} km</div>` : "";
    // Which real major stops the train has actually already halted at on
    // THIS run, in order — built from the same rendered timeline, never a
    // separate guess. Omitted entirely if there are none yet (train still
    // at/near its origin).
    const stops = Array.isArray(coveredStops) ? coveredStops : [];
    const stopsText = stops.length
      ? `<div class="live-timeline__status-covered">Stops covered (${stops.length}): ${stops.map((c) => escapeHtml(c.name)).join(", ")}</div>`
      : "";
    // Real clock time the train reached/crossed this station (RailYatri-
    // style "Crossed X~ at 20:53") — from backend's current_station_actual_time,
    // itself RailKit's own real actual arrival/departure timestamp. Omitted
    // (falls back to just the station name) if RailKit hasn't reported a
    // real time for this station yet.
    const atTime = meta.current_station_actual_time
      ? ` at ${escapeHtml(String(meta.current_station_actual_time))}` : "";
    return `
      <div class="live-timeline__status-popup" data-status-popup hidden>
        <div class="live-timeline__status-asof-bubble" data-status-asof data-status-updated-at="${escapeHtml(meta.status_updated_at || "")}">As of ${formatAsOfAgo(meta.status_updated_at)}</div>
        <div class="live-timeline__status-head">${verb} <strong>${escapeHtml(s.name)}</strong>~${atTime}</div>
        ${haltText ? `<div class="live-timeline__status-halt">${haltText}</div>` : ""}
        ${distanceText}
        ${stopsText}
        ${delayText ? `<div class="live-timeline__status-delay-row">${delayText}</div>` : ""}
        <button type="button" class="live-timeline__report-link" data-report-inaccuracy="${escapeHtml(meta.status_response_id || "")}">Report Inaccuracy</button>
      </div>`;
  }

  function stationRow(s, statusMeta, coveredStops) {
    const statusClass = s.status === "passed" ? "is-passed" : s.status === "current" ? "is-current" : "is-upcoming";
    const noFix = s.lat == null ? `<span class="live-timeline__nofix">no map fix</span>` : "";
    const distKm = resolvedDistanceKm(s);
    const dist = distKm != null ? `${escapeHtml(String(distKm))} km` : "";
    // RailYatri-style "Halt: X min | Y km" line.
    const haltMeta = s.halt_minutes != null && s.halt_minutes !== "" ? `Halt: ${escapeHtml(String(s.halt_minutes))} min` : "halt";
    const metaLine = [haltMeta, dist].filter(Boolean).join(" | ");
    const isCurrent = s.status === "current";
    // Data attributes on the tap target itself so the click handler (which
    // doesn't have this row's closures) can build the same notification
    // text without recomputing anything.
    const stopsForAttr = isCurrent && Array.isArray(coveredStops)
      ? escapeHtml(coveredStops.map((c) => c.name).join(", ")) : "";
    return `
      <div class="live-timeline__row ${statusClass} is-stoppage">
        ${isCurrent
          ? `<button type="button" class="live-timeline__train-icon-btn" data-status-toggle data-station-name="${escapeHtml(s.name)}" data-distance-km="${distKm != null ? escapeHtml(String(distKm)) : ""}" data-stops-covered="${stopsForAttr}" data-stops-covered-count="${Array.isArray(coveredStops) ? coveredStops.length : 0}" aria-label="Show current status">
               <img class="live-timeline__train-icon" src="assets/icons/train-marker.png" alt="Train currently here" />
             </button>`
          : `<div class="live-timeline__dot" aria-hidden="true"></div>`}
        <div class="live-timeline__body">
          <div class="live-timeline__head">
            <span class="live-timeline__name">${escapeHtml(s.name)} <span class="live-timeline__code">(${escapeHtml(s.code)})</span></span>
            <span class="live-timeline__meta">${metaLine} ${noFix}</span>
            ${predictedDelayBadge(s) ? `<div class="live-timeline__predicted-row">${predictedDelayBadge(s)}</div>` : ""}
          </div>
          ${isCurrent ? statusPopupHtml(s, statusMeta, coveredStops) : ""}
          ${timingRow("Arrival", s.arrival)}
          ${timingRow("Departure", s.departure)}
        </div>
      </div>`;
  }

  // Collapsed "+N No-Halt stations" group — RailYatri-style. Click to
  // expand and see each small passing station with its real
  // distance-from-last-halt.
  function noHaltGroupRow(g, idx) {
    const distText = g.distance_km != null ? ` · ${g.distance_km} km` : "";
    const rows = g.stations.map((st) => `
        <div class="live-timeline__nohalt-station">
          <span class="live-timeline__nohalt-name">${escapeHtml(st.name)} <span class="live-timeline__code">(${escapeHtml(st.code)})</span></span>
          ${st.distance_since_last_stoppage_km != null
            ? `<span class="live-timeline__from-last">${Math.abs(st.distance_since_last_stoppage_km)} km ${st.distance_since_last_stoppage_km >= 0 ? "past" : "before"} ${escapeHtml(g.from_station || "")}</span>`
            : ""}
          ${predictedDelayBadge(st)}
        </div>`).join("");
    return `
      <div class="live-timeline__row is-nohalt-group">
        <div class="live-timeline__dot live-timeline__dot--muted" aria-hidden="true"></div>
        <div class="live-timeline__body">
          <button type="button" class="live-timeline__nohalt-toggle" data-nohalt-toggle="${idx}">
            + ${g.count} No-Halt station${g.count === 1 ? "" : "s"}${distText}
            <span class="live-timeline__nohalt-arrow" data-nohalt-arrow="${idx}">▾</span>
          </button>
          <div class="live-timeline__nohalt-detail" data-nohalt-detail="${idx}" hidden>${rows}</div>
        </div>
      </div>`;
  }

  // Wires up the "tap the train icon" status popup + its Report Inaccuracy
  // button. Called once after every innerHTML rebuild of liveTrackTimeline.
  function wireStatusPopup() {
    // Real-time-ticking "As of Xs/mins ago" bubble, RailYatri-style —
    // re-reads each popup's real status_updated_at (set once per WS
    // update) against the CURRENT clock every second, rather than a fixed
    // string frozen at render time. One shared interval per render pass;
    // cleared and restarted here so re-rendering the timeline never stacks
    // up duplicate tickers.
    if (liveStatusAsOfTicker) clearInterval(liveStatusAsOfTicker);
    liveStatusAsOfTicker = setInterval(() => {
      liveTrackTimeline.querySelectorAll("[data-status-asof]").forEach((el) => {
        const iso = el.getAttribute("data-status-updated-at");
        if (iso) el.textContent = `As of ${formatAsOfAgo(iso)}`;
      });
    }, 1000);

    liveTrackTimeline.querySelectorAll("[data-status-toggle]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const popup = btn.parentElement.querySelector("[data-status-popup]");
        if (!popup) return;
        const wasHidden = popup.hidden;
        popup.hidden = !popup.hidden;
        // Push a real browser notification only when the popup is being
        // OPENED (tapped on), not closed — same "tap the train icon" event
        // the mobile app's OS notification fires on. Best-effort: skipped
        // silently if the browser/user hasn't granted permission, exactly
        // like the mobile IS_EXPO_GO fallback-to-in-app-only case.
        if (wasHidden && typeof Notification !== "undefined") {
          const name = btn.getAttribute("data-station-name") || "";
          const distKm = btn.getAttribute("data-distance-km");
          const stopsCount = btn.getAttribute("data-stops-covered-count") || "0";
          const stopsNames = btn.getAttribute("data-stops-covered") || "";
          const lines = [];
          if (distKm) lines.push(`Total distance covered: ${distKm} km`);
          if (stopsCount !== "0") lines.push(`Stops covered (${stopsCount}): ${stopsNames}`);
          const body = lines.length ? lines.join("\n") : "Live position updated";
          const fire = () => { try { new Notification(`Train at ${name}`, { body }); } catch {} };
          if (Notification.permission === "granted") {
            fire();
          } else if (Notification.permission !== "denied") {
            Notification.requestPermission().then((perm) => { if (perm === "granted") fire(); });
          }
        }
      });
    });
    liveTrackTimeline.querySelectorAll("[data-report-inaccuracy]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const responseId = btn.getAttribute("data-report-inaccuracy");
        if (!responseId) return;
        btn.disabled = true;
        btn.textContent = "Reporting…";
        try {
          await fetch(`/api/feedback`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ response_id: responseId, rating: "down", reason: "Reported inaccurate from live tracking status popup" }),
          });
          btn.textContent = "Reported — thanks";
        } catch {
          btn.textContent = "Report Inaccuracy";
          btn.disabled = false;
        }
      });
    });
  }

  function renderLiveTimeline(timelineGrouped, timelineFlat, statusMeta) {
    if (!liveTrackTimeline) return;
    // FEATURE: every station stays visible and live - reporting halts AND
    // small non-reporting/intermediate points alike, none collapsed away
    // into a "+N No-Halt stations" popup and none silently skipped. This
    // is now the PRIMARY path (the flat, complete `timelineFlat` list),
    // not a fallback - every entry already carries its own live
    // predicted delay/ETA (see _predict_delay_per_reporting_station,
    // which was extended to intermediate stations earlier), so nothing is
    // lost by not grouping; the grouped/collapsed structure is kept only
    // as a last-resort fallback for a stale cached payload that doesn't
    // have the flat list at all.
    if (Array.isArray(timelineFlat) && timelineFlat.length) {
      const coveredStops = timelineFlat
        .filter((s) => s.kind !== "intermediate" && s.status === "passed")
        .map((s) => ({ code: s.code, name: s.name }));
      liveTrackTimeline.innerHTML = timelineFlat.map((s) => stationRow(s, statusMeta, coveredStops)).join("");
      wireStatusPopup();
      return;
    }
    if (Array.isArray(timelineGrouped) && timelineGrouped.length) {
      // Real major (halting) stops the train has already passed on THIS
      // run, in route order — every entry here is a genuine station RailKit
      // reported as status "passed", never a guess about what "should"
      // have been crossed by now.
      const coveredStops = timelineGrouped
        .filter((e) => e.display_type !== "no_halt_group" && e.status === "passed")
        .map((e) => ({ code: e.code, name: e.name }));
      liveTrackTimeline.innerHTML = timelineGrouped.map((entry, idx) =>
        entry.display_type === "no_halt_group" ? noHaltGroupRow(entry, idx) : stationRow(entry, statusMeta, coveredStops)
      ).join("");
      liveTrackTimeline.querySelectorAll("[data-nohalt-toggle]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const i = btn.getAttribute("data-nohalt-toggle");
          const detail = liveTrackTimeline.querySelector(`[data-nohalt-detail="${i}"]`);
          const arrow = liveTrackTimeline.querySelector(`[data-nohalt-arrow="${i}"]`);
          if (!detail) return;
          detail.hidden = !detail.hidden;
          if (arrow) arrow.textContent = detail.hidden ? "▾" : "▴";
        });
      });
      wireStatusPopup();
      return;
    }
    liveTrackTimeline.innerHTML = `<p class="result-list--empty">No stop-by-stop timeline available for this train yet.</p>`;
  }

  function drawLiveTrackRoute(timeline) {
    if (!liveTrackMap || !Array.isArray(timeline)) return;
    const points = timeline.filter((s) => s.lat != null && s.lng != null);
    if (liveTrackRouteLayer) {
      liveTrackMap.removeLayer(liveTrackRouteLayer);
      liveTrackRouteLayer = null;
    }
    if (points.length < 2) return;

    liveTrackRouteLayer = L.layerGroup();
    L.polyline(points.map((s) => [s.lat, s.lng]), { color: "#16324F", weight: 3 }).addTo(liveTrackRouteLayer);
    points.forEach((s) => {
      const color = s.status === "passed" ? "#2E8B57" : s.status === "current" ? "#C1272D" : "#8a93a1";
      L.circleMarker([s.lat, s.lng], {
        radius: s.kind === "intermediate" ? 3 : 5,
        color, fillColor: color, fillOpacity: 1, weight: 1,
      }).bindTooltip(`${s.name} (${s.code})`).addTo(liveTrackRouteLayer);
    });
    liveTrackRouteLayer.addTo(liveTrackMap);

    if (!liveTrackRouteBoundsFit) {
      liveTrackMap.fitBounds(points.map((s) => [s.lat, s.lng]), { padding: [30, 30] });
      liveTrackRouteBoundsFit = true;
    }
  }

  function closeLiveTrackSocket() {
    liveTrackWantsConnection = false;
    if (liveTrackReconnectTimer) {
      clearTimeout(liveTrackReconnectTimer);
      liveTrackReconnectTimer = null;
    }
    if (liveTrackSocket) {
      try { liveTrackSocket.close(); } catch {}
      liveTrackSocket = null;
    }
    stopLtShareInterval();
    stopLtAlarm();
    stopLtCoachCrowdPolling();
  }

  function startLiveTrack(trainNumber) {
    closeLiveTrackSocket();
    liveTrackWantsConnection = true;
    setStatus(liveTrackStatus, `Connecting to live feed for train ${trainNumber}…`);
    liveTrackStats.hidden = true;
    if (liveTrackQuickBar) liveTrackQuickBar.hidden = true;
    if (liveTrackTimeline) {
      liveTrackTimeline.innerHTML = `<p class="result-list--empty">Loading stop-by-stop running status…</p>`;
    }
    // A stale crowd-position overlay / explain result from a PREVIOUSLY
    // tracked train would be actively misleading pinned to the new train's
    // map — clear both before the new feed starts.
    if (ltCrowdMarker && liveTrackMap) { liveTrackMap.removeLayer(ltCrowdMarker); ltCrowdMarker = null; }
    if (ltCrowdCircle && liveTrackMap) { liveTrackMap.removeLayer(ltCrowdCircle); ltCrowdCircle = null; }
    lastKnownDelayMinutes = null;
    const ltExplainResultEl = document.getElementById("ltExplainResult");
    if (ltExplainResultEl) ltExplainResultEl.hidden = true;
    const ltCrowdBadgeCardEl = document.getElementById("ltCrowdBadgeCard");
    if (ltCrowdBadgeCardEl) ltCrowdBadgeCardEl.hidden = true;
    liveTrackRouteBoundsFit = false;
    if (liveTrackRouteLayer && liveTrackMap) {
      liveTrackMap.removeLayer(liveTrackRouteLayer);
      liveTrackRouteLayer = null;
    }
    liveTrackedTrainNumber = trainNumber;
    initLiveTrackChart(trainNumber);
    loadLiveTrackRouteStats(trainNumber); // fire-and-forget; fills in distance fallback when it resolves
    stopLtAlarm(); // a stale armed alarm from a PREVIOUSLY tracked train shouldn't carry over to this one
    ltCurrentStationCode = null;
    ltNextStationCode = null;

    // A stale re-route alert from a PREVIOUSLY tracked train would be just
    // as misleading as a stale crowd overlay/explain result — clear it too.
    renderRerouteAlert(null);
    renderDeviationAlert(null);

    // FEATURE: delay-trend sparkline + end-of-trip summary — both reset for
    // a fresh tracked train, same reasoning as the crowd overlay/explain
    // clears above (stale data from a PREVIOUSLY tracked train would be
    // actively misleading here too).
    ltDelaySparkline = [];
    const sparklineCardEl = document.getElementById("ltSparklineCard");
    if (sparklineCardEl) sparklineCardEl.hidden = true;
    ltTripSummaryShownKey = null;
    const tripSummaryCardEl = document.getElementById("ltTripSummaryCard");
    if (tripSummaryCardEl) { tripSummaryCardEl.hidden = true; tripSummaryCardEl.innerHTML = ""; }

    // FEATURE: Real-Time Per-Coach Crowding — (re)start polling for the
    // newly tracked train.
    startLtCoachCrowdPolling(trainNumber);

    // FEATURE: Connection-Risk Alert — if the user has a PNR watch on file
    // for a DIFFERENT train, offer a one-tap prefill instead of making them
    // discover/type the connecting train number themselves.
    checkPnrConnectionPrompt(trainNumber);

    // FEATURE: Crowd-Sourced Train Position — mobile-first GPS. If the
    // passenger already opted into auto-sharing for a previous train this
    // session, keep it on for the new one too (no need to ask twice);
    // otherwise reset so the proactive prompt can ask again for this train.
    const sharePromptEl = document.getElementById("ltSharePositionPrompt");
    if (sharePromptEl) sharePromptEl.hidden = true;
    if (ltShareMyPositionEnabled) {
      ltSharePromptHandledForTrain = trainNumber;
      startLtShareInterval(trainNumber);
    } else {
      ltSharePromptHandledForTrain = null;
      stopLtShareInterval();
    }

    const params = new URLSearchParams();
    const isoDate = document.getElementById("liveTrackDateInput").value;
    const ddmmyyyy = toDDMMYYYY(isoDate);
    if (ddmmyyyy) params.set("date", ddmmyyyy);
    const source = document.getElementById("liveTrackSourceInput").value.trim().toUpperCase();
    const dest = document.getElementById("liveTrackDestInput").value.trim().toUpperCase();
    if (source) params.set("source", source);
    if (dest) params.set("dest", dest);
    const travelClass = document.getElementById("liveTrackClassSelect").value;
    if (travelClass) params.set("travel_class", travelClass);
    const qs = params.toString();

    let socket;
    try {
      socket = new WebSocket(`${WS_BASE}/ws/track/${encodeURIComponent(trainNumber)}${qs ? "?" + qs : ""}`);
    } catch {
      setStatus(liveTrackStatus, "Could not open a WebSocket connection.", "is-error");
      return;
    }
    liveTrackSocket = socket;

    socket.onopen = () => {
      liveTrackReconnectAttempts = 0;  // a real successful connection resets the backoff
      setStatus(liveTrackStatus, `Live — streaming updates for train ${trainNumber}`, "is-live");
    };
    socket.onclose = () => {
      if (liveTrackSocket !== socket) return;  // an already-replaced/stale socket closing - ignore
      liveTrackSocket = null;
      if (!liveTrackWantsConnection) {
        setStatus(liveTrackStatus, "Disconnected.");
        return;
      }
      // FEATURE: auto-reconnect. The user asked to click Track once and
      // have it keep updating on its own - a dropped connection shouldn't
      // require noticing "Disconnected" and clicking again. Capped
      // exponential backoff (2s, 4s, 8s... up to 30s) so a genuinely dead
      // backend doesn't get hammered with reconnect attempts forever.
      liveTrackReconnectAttempts += 1;
      const maxAttempts = 8;
      if (liveTrackReconnectAttempts > maxAttempts) {
        setStatus(liveTrackStatus, "Lost connection and couldn't reconnect after several tries. Click Track to try again.", "is-error");
        liveTrackWantsConnection = false;
        return;
      }
      const delayMs = Math.min(30000, 2000 * (2 ** (liveTrackReconnectAttempts - 1)));
      setStatus(liveTrackStatus, `Connection dropped — reconnecting in ${Math.round(delayMs / 1000)}s… (attempt ${liveTrackReconnectAttempts}/${maxAttempts})`, "is-error");
      liveTrackReconnectTimer = setTimeout(() => {
        liveTrackReconnectTimer = null;
        if (liveTrackWantsConnection) startLiveTrack(trainNumber);
      }, delayMs);
    };
    socket.onerror = () => setStatus(liveTrackStatus, "Connection error.", "is-error");

    socket.onmessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }

      // IMPORTANT: don't bail out on data.error — crowd prediction is fetched
      // independently server-side and can still be valid even when the live
      // position/status fetch itself failed, so keep processing the rest of
      // the payload instead of dropping it all on the floor.
      if (data.error) {
        setStatus(liveTrackStatus, `Live — but the last position/status fetch failed: ${data.error}`, "is-error");
      } else {
        setStatus(liveTrackStatus, `Live — streaming updates for train ${data.train_number}`, "is-live");

        ensureLiveTrackMap();
        drawLiveTrackRoute(data.timeline);

        // Prefer the live-position fix; if that tier came back genuinely
        // unavailable, fall back to the last "passed"/"current" stop in
        // the route that DOES have a resolvable coordinate (real, table,
        // or interpolated) rather than leaving the map with no marker at
        // all — same honesty rule as the position itself, just applied to
        // marker placement: we say plainly which one this is via the caption.
        let markerLat = data.lat, markerLng = data.lng, usedRouteFallback = false;
        if ((markerLat == null || markerLng == null) && Array.isArray(data.timeline)) {
          const passedWithFix = data.timeline.filter((s) => s.lat != null && (s.status === "passed" || s.status === "current"));
          const last = passedWithFix[passedWithFix.length - 1];
          if (last) { markerLat = last.lat; markerLng = last.lng; usedRouteFallback = true; }
        }

        if (liveTrackMap && markerLat != null && markerLng != null) {
          if (!liveTrackMarker) {
            liveTrackMarker = trainMarkerIcon
              ? L.marker([markerLat, markerLng], { icon: trainMarkerIcon }).addTo(liveTrackMap)
              : L.marker([markerLat, markerLng]).addTo(liveTrackMap);
          } else {
            liveTrackMarker.setLatLng([markerLat, markerLng]);
          }
          liveTrackMarker.bindPopup(`Train ${data.train_number}<br>${escapeHtml(data.current_station || "")}${data.direction ? `<br>Direction: ${escapeHtml(data.direction)}` : ""}`);
          // Rotate/flip the marker to face the auto-detected UP/DOWN
          // direction — re-applied every tick since Leaflet may recreate
          // the marker's <img> element internally.
          applyTrainMarkerDirection(data.direction);
          if (!liveTrackRouteBoundsFit) {
            liveTrackMap.setView([markerLat, markerLng], liveTrackMap.getZoom() < 6 ? 7 : liveTrackMap.getZoom());
          }
          const captions = {
            provider: "Live position from data provider",
            interpolated_on_route: "No exact fix for this station — position interpolated along the real route between the nearest known stations",
            estimated_from_last_station: "Estimated from last known station (no live GPS fix from provider)",
            railradar_segment_progress: "Live position — smoothly tracked between stations via RailRadar's real-time GPS progress",
          };
          const positionCaption = usedRouteFallback
            ? "No live fix yet — showing last confirmed position on the route"
            : (captions[data.position_source] || "Live position from data provider");
          liveTrackCaption.textContent = data.direction && data.direction !== "UNKNOWN"
            ? `${positionCaption} · Running ${data.direction}`
            : positionCaption;
        } else if (liveTrackMap) {
          liveTrackCaption.textContent = "No position available yet for this train — route shown above once station coordinates resolve.";
        }

        renderLiveTimeline(data.timeline_grouped, data.timeline, {
          delay_minutes: data.delay_minutes,
          status_response_id: data.status_response_id,
          status_updated_at: data.status_updated_at,
          current_station_kind: data.current_station_kind,
          current_station_halt_minutes: data.current_station_halt_minutes,
        });
        updateLiveTrackChartFromTimeline(data.timeline);

        liveTrackStats.hidden = false;
        if (liveTrackQuickBar) liveTrackQuickBar.hidden = false;
        // FEATURE: "RailRadar wins wherever it has live data" - current
        // station now prefers RailRadar's real GPS-sourced station code
        // over RailKit's own (possibly cache-lagged) pointer when
        // RailRadar has an actual fix; a small tag makes it clear when
        // that happened, same honesty pattern as the position caption.
        document.getElementById("ltCurrentStation").textContent = data.current_station
          ? `${data.current_station}${data.current_station_source === "railradar_live_gps" ? " (live GPS)" : ""}`
          : "—";
        document.getElementById("ltNextStation").textContent = data.next_station || "—";
        // FEATURE: Station Navigator / Catering / Smart Alarm all want a
        // real station CODE, not just the display name above.
        ltCurrentStationCode = data.current_station_code || null;
        ltNextStationCode = data.next_station_code || null;
        {
          // RailYatri-style red/green "43m late" pill in the quick bar —
          // same delay_minutes value as the old plain-text stat row, just
          // color-coded now that it's a headline element instead of one
          // row in a 17-row table.
          const ltDelayEl = document.getElementById("ltDelay");
          ltDelayEl.textContent = data.delay_minutes != null
            ? `${data.delay_minutes > 0 ? "+" : ""}${formatDelayDuration(data.delay_minutes)}${data.delay_minutes > 0 ? " late" : data.delay_minutes < 0 ? " early" : " on time"}`
            : "Unknown";
          ltDelayEl.classList.remove("is-late", "is-early", "is-ontime");
          if (data.delay_minutes != null) {
            ltDelayEl.classList.add(data.delay_minutes > 0 ? "is-late" : data.delay_minutes < 0 ? "is-early" : "is-ontime");
          }
        }
        if (data.delay_minutes != null) lastKnownDelayMinutes = data.delay_minutes;

        // FEATURE: Dynamic Re-route Suggestions During Live Tracking — see
        // backend/reroute_suggestions.py. Rides along on the same live
        // poll, only visible once this train's delay crosses the severity
        // threshold server-side.
        renderRerouteAlert(data.reroute_suggestion);

        // FEATURE: Route-Deviation/Diversion Detection — see
        // backend/route_deviation.py. Rides along on the same poll.
        renderDeviationAlert(data.route_deviation);

        // FEATURE: Crowd-Sourced Train Position — mobile-first GPS. Prompt
        // once per tracked train (not every poll) instead of leaving
        // position-sharing buried in the Crowd Positions tab.
        maybeShowSharePositionPrompt(data.train_number);

        // Crowd-sourced position overlay rides along on the same live poll
        // cadence as everything else on this map, when the user has
        // switched it on — see ltCrowdOverlayToggle below.
        if (ltCrowdOverlayEnabled && data.train_number) refreshLtCrowdOverlay(data.train_number);
        {
          const ltPredictedDelayEl = document.getElementById("ltPredictedDelay");
          if (data.predicted_delay_minutes != null) {
            const hasBand = data.predicted_delay_low_minutes != null && data.predicted_delay_high_minutes != null;
            const bandText = hasBand ? ` [range ${formatDelayDuration(data.predicted_delay_low_minutes)}\u2013${formatDelayDuration(data.predicted_delay_high_minutes)}]` : "";
            ltPredictedDelayEl.textContent = `~${formatDelayDuration(data.predicted_delay_minutes)}${bandText} (${data.predicted_delay_confidence || "?"} confidence, ML estimate)`;
          } else {
            ltPredictedDelayEl.textContent = "—";
          }
        }
        document.getElementById("ltSource").textContent = data.position_source || "—";
        document.getElementById("ltUpdated").textContent = new Date().toLocaleTimeString();
        const ltDirectionEl = document.getElementById("ltDirection");
        if (ltDirectionEl) ltDirectionEl.textContent = data.direction && data.direction !== "UNKNOWN" ? data.direction : "—";
        const ltAvgSpeedEl = document.getElementById("ltAvgSpeed");
        if (ltAvgSpeedEl) {
          ltAvgSpeedEl.textContent = data.avg_speed_kmph != null
            ? `${data.avg_speed_kmph} km/h${formatAvgSpeedSourceTag(data.avg_speed_source)}`
            : "—";
        }
        // FEATURE: instant speed per GPS ping, recency-weighted for
        // display so a single noisy poll doesn't spike the number.
        // Prefer the smoothed reading; fall back to the raw instant
        // reading; then to display_speed_kmph, the tier-3 avg-speed
        // estimate the backend fills in whenever NEITHER a live-GPS nor a
        // distance-delta ping has come through yet this session (e.g. this
        // train has no live RailRadar GPS feed at all — the case where the
        // map shows "position interpolated"). Only shows "waiting for next
        // ping" once even that estimate is unavailable.
        const ltInstantSpeedEl = document.getElementById("ltInstantSpeed");
        if (ltInstantSpeedEl) {
          const liveSpeed = data.recency_weighted_speed_kmph != null
            ? data.recency_weighted_speed_kmph
            : (data.instant_speed_kmph != null ? data.instant_speed_kmph : data.display_speed_kmph);
          const speedSource = data.recency_weighted_speed_kmph != null || data.instant_speed_kmph != null
            ? data.instant_speed_source
            : data.display_speed_source;
          const isEstimate = speedSource === "avg_speed_estimate";
          ltInstantSpeedEl.textContent = liveSpeed != null
            ? `${liveSpeed} km/h${isEstimate ? " (avg, est.)" : formatAvgSpeedSourceTag(speedSource)}`
            : "— (waiting for next ping)";
        }
        // FEATURE: next-station ETA, recalculated every ping — distinct
        // from the provider's own `expected` field (next_station_expected_arrival),
        // which only updates when RailKit itself refreshes it.
        const ltNextEtaEl = document.getElementById("ltNextEta");
        if (ltNextEtaEl) {
          ltNextEtaEl.textContent = data.next_station_live_eta
            || data.next_station_expected_arrival
            || "—";
        }
        const ltDelayTrendEl = document.getElementById("ltDelayTrend");
        if (ltDelayTrendEl) {
          ltDelayTrendEl.textContent = data.recent_delay_trend_per_stop != null
            ? `${data.recent_delay_trend_per_stop > 0 ? "+" : ""}${data.recent_delay_trend_per_stop.toFixed(1)} min/station`
            : "—";
        }

        // FEATURE: live weather (see backend/weather.py, WeatherAPI.com) at
        // the train's current position and at the next station. Shows the
        // real reason text ("weather_source_error") when the key isn't
        // configured or the call failed, instead of a bare dash.
        function formatWeather(w) {
          if (!w) return null;
          const parts = [w.condition || "—"];
          if (w.temp_c != null) parts.push(`${w.temp_c}°C`);
          if (w.visibility_km != null) parts.push(`vis ${w.visibility_km} km`);
          if (w.precip_mm != null && w.precip_mm > 0) parts.push(`${w.precip_mm} mm/hr rain`);
          return parts.join(" · ");
        }
        const ltWeatherCurrentEl = document.getElementById("ltWeatherCurrent");
        if (ltWeatherCurrentEl) {
          ltWeatherCurrentEl.textContent = formatWeather(data.current_weather)
            || (data.weather_source_error ? `Unavailable (${data.weather_source_error})` : "—");
        }
        const ltWeatherNextEl = document.getElementById("ltWeatherNext");
        if (ltWeatherNextEl) {
          ltWeatherNextEl.textContent = formatWeather(data.next_station_weather) || "—";
        }
        // FEATURE: real progress between stations (RailRadar segmentProgress
        // — see railradar_fallback.get_segment_progress), moves every poll
        // instead of only when RailKit's own "current station" changes.
        const ltSegmentProgressEl = document.getElementById("ltSegmentProgress");
        if (ltSegmentProgressEl) {
          ltSegmentProgressEl.textContent = data.segment_progress_pct != null
            ? `${data.segment_progress_pct}% of the way to the next station (live GPS)`
            : "—";
        }
        // FEATURE: distance covered/remaining toward the next station,
        // both recomputed every poll off the same live position figure
        // that already drives the map marker and speed - not gated behind
        // "current station" changing the way RailKit's own field is.
        const ltDistanceCoveredEl = document.getElementById("ltDistanceCovered");
        if (ltDistanceCoveredEl) {
          ltDistanceCoveredEl.textContent = data.distance_covered_since_last_stop_km != null
            ? `${data.distance_covered_since_last_stop_km} km`
            : "—";
        }
        const ltDistanceRemainingEl = document.getElementById("ltDistanceRemaining");
        if (ltDistanceRemainingEl) {
          ltDistanceRemainingEl.textContent = data.distance_remaining_to_next_km != null
            ? `${data.distance_remaining_to_next_km} km`
            : "—";
        }
        const weatherBasisEl = document.getElementById("ltWeatherBasis");
        if (weatherBasisEl) {
          if (data.weather_basis) {
            weatherBasisEl.hidden = false;
            weatherBasisEl.textContent = `Weather impact on prediction: +${data.weather_delay_component_minutes} min — ${data.weather_basis}`;
          } else {
            weatherBasisEl.hidden = true;
          }
        }

        const basisEl = document.getElementById("ltPredictedDelayBasis");
        if (data.predicted_delay_basis && data.predicted_delay_basis.length) {
          basisEl.hidden = false;
          basisEl.textContent = `Why: ${data.predicted_delay_basis.join("; ")}`;
        } else {
          basisEl.hidden = true;
        }

        // FEATURE: delay-trend sparkline — feed this poll's figure
        // (predicted, falling back to reported) into the rolling buffer.
        const sparkValue = data.predicted_delay_minutes != null ? data.predicted_delay_minutes : data.delay_minutes;
        if (sparkValue != null) updateLtSparkline(sparkValue);

        // FEATURE: End-of-Trip Summary Card — build once the train has
        // genuinely reached its final destination (a real recorded actual
        // arrival, not just "upcoming"/predicted).
        if (data.destination_actual_arrival) {
          maybeShowTripSummary(data);
        }
      }

      // Crowd prediction rides along on every tick, independent of whether
      // the position/live-status half of this payload succeeded.
      if (data.crowd_level) {
        renderCrowd({
          level: data.crowd_level, score: data.crowd_score, basis: data.crowd_basis,
          disclaimer: data.crowd_disclaimer, seatDataError: data.crowd_seat_data_error,
        });
      }
    };
  }

  // -------------------------------------------------------------
  // FEATURE: "Smart Alarm" — Dynamic Departure Reminder. Polls the real
  // /api/advanced/smart-alarm endpoint (same one the More Tools "Smart
  // Alarm" tab uses on-demand) every LT_ALARM_POLL_MS while armed, and
  // fires a real browser Notification once the predicted ETA at the
  // chosen station comes within the lead time — auto-adjusting to a
  // revised (delayed/recovered) ETA on every poll, unlike a plain
  // setTimeout against a fixed clock time. See SMART_ALARM_DISCLAIMER on
  // the backend for why this needs the tab to stay open/backgrounded.
  // -------------------------------------------------------------
  const ltAlarmForm = document.getElementById("ltAlarmForm");
  const ltAlarmStatus = document.getElementById("ltAlarmStatus");
  const ltAlarmSetBtn = document.getElementById("ltAlarmSetBtn");

  function stopLtAlarm() {
    if (ltAlarmIntervalId) { clearInterval(ltAlarmIntervalId); ltAlarmIntervalId = null; }
    if (ltAlarmPreciseTimeoutId) { clearTimeout(ltAlarmPreciseTimeoutId); ltAlarmPreciseTimeoutId = null; }
    ltAlarmFired = false;
    if (ltAlarmSetBtn) ltAlarmSetBtn.textContent = "Set Alarm";
  }

  async function checkLtAlarm(trainNumber, station, leadMinutes, date) {
    try {
      const res = await fetch("/api/advanced/smart-alarm", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ train_number: trainNumber, destination_station: station, date: date || null, lead_minutes: leadMinutes }),
      });
      const data = await res.json();
      if (!data.found) {
        setStatus(ltAlarmStatus, data.note || "Couldn't check this station right now.", "is-error");
        return;
      }
      if (data.already_passed) {
        setStatus(ltAlarmStatus, `Train ${trainNumber} has already reached ${station} — stopping the alarm.`);
        stopLtAlarm();
        return;
      }
      const etaText = data.minutes_remaining != null ? `~${data.minutes_remaining} min away` : "ETA unavailable this poll";
      const delayText = data.delay_minutes ? ` (running ${formatDelayDuration(data.delay_minutes)} late)` : "";
      setStatus(ltAlarmStatus, `⏰ Armed for ${station} — ${etaText}${delayText}. Notifying ${leadMinutes} min before arrival.`);

      const fireLtAlarmNow = () => {
        if (ltAlarmFired) return;
        ltAlarmFired = true;
        const body = `Train ${trainNumber} is due at ${station} in about ${data.minutes_remaining != null ? data.minutes_remaining : "a few"} min${delayText}. Time to head out!`;
        try {
          if (Notification.permission === "granted") new Notification(`⏰ Smart Alarm — ${station}`, { body, icon: "/assets/icons/train-marker.png" });
        } catch { /* ignore — status line above still shows it */ }
        setStatus(ltAlarmStatus, `🔔 Alarm fired — ${body}`);
        stopLtAlarm();
      };

      if (data.alarm_now && !ltAlarmFired) {
        fireLtAlarmNow();
      } else if (!ltAlarmFired) {
        // Re-check exactly when the real due moment (server IST clock)
        // arrives on THIS device's own clock, rather than waiting up to
        // LT_ALARM_POLL_MS for the next scheduled poll to notice.
        scheduleLtAlarmPrecise(data.alarm_at_iso, () => checkLtAlarm(trainNumber, station, leadMinutes, date));
      }
    } catch {
      setStatus(ltAlarmStatus, "Couldn't reach the backend for the alarm check just now — will retry.", "is-error");
    }
  }

  // FEATURE: Background-surviving Smart Alarm — registers/clears the
  // server-side push watch (see /api/push/alarms). `watch` null clears
  // the current device's alarm watchlist entirely (this feature only ever
  // arms ONE alarm at a time from this UI, so "replace the full set" from
  // push_store.replace_alarm_watches is safe to call with a single-item
  // or empty array here). Relies on window.getOrCreateWebPushToken, set
  // up alongside FIREBASE_CONFIG further down this file (see comment
  // there) — defined by the time any user interaction could call this.
  async function syncBackgroundAlarmToServer(watch) {
    if (typeof window.getOrCreateWebPushToken !== "function") {
      return { ok: false, error: "Push isn't available in this browser yet." };
    }
    let token;
    try {
      token = await window.getOrCreateWebPushToken();
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : "Couldn't get a push token." };
    }
    if (!token) return { ok: false, error: "Couldn't get a push token from this browser." };
    return ltPostJSON("/api/push/alarms", { token, watches: watch ? [watch] : [] });
  }

  if (ltAlarmForm) {
    ltAlarmForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (ltAlarmIntervalId) {
        const wasBackground = ltAlarmBackgroundActive;
        stopLtAlarm();
        if (wasBackground) {
          ltAlarmBackgroundActive = false;
          syncBackgroundAlarmToServer(null).catch(() => {});
        }
        setStatus(ltAlarmStatus, "Alarm cancelled.");
        return;
      }
      if (!liveTrackedTrainNumber) { setStatus(ltAlarmStatus, "Track a train above first.", "is-error"); return; }
      const station = document.getElementById("ltAlarmStationInput").value.trim().toUpperCase();
      const leadMinutes = parseInt(document.getElementById("ltAlarmLeadInput").value, 10) || 45;
      if (!station) { setStatus(ltAlarmStatus, "Enter a station code.", "is-error"); return; }
      if (!("Notification" in window)) { setStatus(ltAlarmStatus, "This browser doesn't support notifications.", "is-error"); return; }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") { setStatus(ltAlarmStatus, "Notification permission was not granted.", "is-error"); return; }
      const date = toDDMMYYYY(document.getElementById("liveTrackDateInput").value);
      ltAlarmFired = false;
      ltAlarmSetBtn.textContent = "Cancel Alarm";
      checkLtAlarm(liveTrackedTrainNumber, station, leadMinutes, date);
      ltAlarmIntervalId = setInterval(() => checkLtAlarm(liveTrackedTrainNumber, station, leadMinutes, date), LT_ALARM_POLL_MS);

      const wantsBackground = document.getElementById("ltAlarmBackgroundToggle") && document.getElementById("ltAlarmBackgroundToggle").checked;
      if (wantsBackground) {
        const result = await syncBackgroundAlarmToServer({
          train_number: liveTrackedTrainNumber, station, date, lead_minutes: leadMinutes,
        });
        if (result && result.ok) {
          ltAlarmBackgroundActive = true;
          setStatus(ltAlarmStatus, `⏰ Armed for ${station} — also registered for background push (will fire even if you close this tab).`);
        } else {
          setStatus(ltAlarmStatus, `⏰ Armed for ${station} (in-tab only — background push failed: ${(result && result.error) || "unknown error"}).`, "is-error");
        }
      }
    });
  }

  // -------------------------------------------------------------
  // FEATURE: On-Board Catering "Pre-Order" Gateway — real deep link to
  // IRCTC's own e-catering portal. IRCTC's site takes the PNR/train
  // number as a manual search step on-page (it doesn't expose a query-
  // param pre-fill), but DOES have a real per-station outlets URL
  // (ecatering.irctc.co.in/station/<CODE>/outlets) — used when this
  // train's current/next real station code is known, so the link lands
  // somewhere actually useful instead of just the homepage.
  // -------------------------------------------------------------
  const ltOrderFoodBtn = document.getElementById("ltOrderFoodBtn");
  if (ltOrderFoodBtn) {
    ltOrderFoodBtn.addEventListener("click", () => {
      const stationCode = ltNextStationCode || ltCurrentStationCode;
      const url = stationCode
        ? `https://www.ecatering.irctc.co.in/station/${encodeURIComponent(stationCode)}/outlets`
        : "https://www.ecatering.irctc.co.in/";
      window.open(url, "_blank", "noopener");
    });
  }

  // -------------------------------------------------------------
  // FEATURE: "Station Navigator" — Point of Interest Finder, for the
  // train's current real station.
  // -------------------------------------------------------------
  const ltStationNavBtn = document.getElementById("ltStationNavBtn");
  const ltStationNavResult = document.getElementById("ltStationNavResult");
  if (ltStationNavBtn) {
    ltStationNavBtn.addEventListener("click", async () => {
      const stationCode = ltCurrentStationCode || ltNextStationCode;
      if (!stationCode) {
        ltStationNavResult.hidden = false;
        ltStationNavResult.innerHTML = `<p>No current station code yet — start tracking a train and wait for a live position first.</p>`;
        return;
      }
      ltStationNavResult.hidden = false;
      ltStationNavResult.innerHTML = `<p>Loading…</p>`;
      try {
        const res = await fetch(`/api/advanced/station-navigator/${encodeURIComponent(stationCode)}`);
        const data = await res.json();
        ltStationNavResult.innerHTML = renderStationNavHtml(data);
      } catch {
        ltStationNavResult.innerHTML = `<p>Couldn't reach the backend just now.</p>`;
      }
    });
  }

  function renderStationNavHtml(data) {
    const entrances = (data.entrance_sides || []).length
      ? `<ul>${data.entrance_sides.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>` : "";
    const facilities = (data.facilities || []).length
      ? `<ul>${data.facilities.map((f) => `<li><strong>${escapeHtml(f.label)}</strong> — ${escapeHtml(f.typical_location_note)}</li>`).join("")}</ul>`
      : `<p>No curated facility list for this station.</p>`;
    return `
      <h4>${escapeHtml(data.name || data.station)} <span class="tools-badge">${data.station_platform_count} platform(s)${data.platform_count_basis === "known" ? "" : " (estimated)"}</span></h4>
      ${data.notable_note ? `<p>${escapeHtml(data.notable_note)}</p>` : ""}
      ${entrances ? `<p><strong>Entrance sides:</strong></p>${entrances}` : ""}
      <p><strong>Facilities:</strong></p>
      ${facilities}
      <p><strong>Layout guidance:</strong></p>
      <ul>${(data.layout_guidance || []).map((g) => `<li>${escapeHtml(g)}</li>`).join("")}</ul>
      <div class="tools-disclaimer">${escapeHtml(data.disclaimer || "")}</div>`;
  }

  // -------------------------------------------------------------
  // FEATURE: Train Capacity & Crowd Prediction — a proper dedicated
  // panel (not just buried in a chat answer), fed by real seat-
  // availability data via /api/crowd/predict, always with its full
  // basis + disclaimer shown so the estimate is genuinely explained.
  // Also auto-updates from the live-tracking WebSocket feed above
  // (see renderCrowd()) whenever source/destination were filled in there.
  // -------------------------------------------------------------
  const crowdForm = document.getElementById("crowdForm");
  const crowdSourceInput = document.getElementById("crowdSourceInput");
  const crowdDestInput = document.getElementById("crowdDestInput");
  const crowdDateInput = document.getElementById("crowdDateInput");
  const crowdClassSelect = document.getElementById("crowdClassSelect");
  const crowdStatus = document.getElementById("crowdStatus");
  const crowdResult = document.getElementById("crowdResult");

  crowdForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const trainNumber = liveTrackInput.value.trim();
    if (!/^\d{5}$/.test(trainNumber)) {
      setStatus(crowdStatus, "Enter a valid 5-digit train number in the field above first.", "is-error");
      return;
    }
    const source = crowdSourceInput.value.trim().toUpperCase();
    const dest = crowdDestInput.value.trim().toUpperCase();
    const date = toDDMMYYYY(crowdDateInput.value);
    if (!source || !dest || !date) {
      setStatus(crowdStatus, "Source, destination, and date are all required.", "is-error");
      return;
    }
    setStatus(crowdStatus, "Predicting…");
    crowdResult.hidden = true;
    try {
      const res = await fetch("/api/crowd/predict", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ train_number: trainNumber, source, dest, date, travel_class: crowdClassSelect.value }),
      });
      const data = await res.json();
      renderCrowd({
        level: data.level, score: data.score, basis: data.basis,
        disclaimer: data.disclaimer, seatDataError: data.seat_data_error,
      });
    } catch {
      setStatus(crowdStatus, "Couldn't reach the backend just now.", "is-error");
    }
  });

  document.getElementById("liveTrackOptionsForm").addEventListener("submit", (e) => e.preventDefault());

  wireModal(liveTrackBtn, liveTrackModal, liveTrackClose, () => {
    requestAnimationFrame(ensureLiveTrackMap);
    const todayIso = new Date().toISOString().slice(0, 10);
    const ltDate = document.getElementById("liveTrackDateInput");
    if (ltDate && !ltDate.value) ltDate.value = todayIso;
    if (crowdDateInput && !crowdDateInput.value) crowdDateInput.value = todayIso;
  });
  liveTrackClose.addEventListener("click", closeLiveTrackSocket);
  liveTrackModal.addEventListener("click", (e) => { if (e.target === liveTrackModal) closeLiveTrackSocket(); });
  liveTrackForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const trainNumber = liveTrackInput.value.trim();
    if (!/^\d{5}$/.test(trainNumber)) {
      setStatus(liveTrackStatus, "Please enter a valid 5-digit train number.", "is-error");
      return;
    }
    liveTrackReconnectAttempts = 0;  // fresh user-initiated request - don't carry over a previous session's backoff count
    startLiveTrack(trainNumber);
  });

  // -------------------------------------------------------------
  // FEATURE: Shareable Read-Only Tracking Link — desktop hand-off.
  // Opening a /track/12951 link on a desktop browser gets redirected
  // server-side (see backend's track_share_page) to "/?openTrack=12951"
  // so this full app UI opens instead of the phone-sized lite page. On
  // load, detect that query param, auto-open the Live Tracking panel,
  // and start tracking immediately — the visitor shouldn't have to
  // re-type the train number they already clicked a link for.
  // -------------------------------------------------------------
  (function autoOpenTrackFromShareLink() {
    const params = new URLSearchParams(location.search);
    const autoTrainNumber = params.get("openTrack");
    if (!autoTrainNumber || !/^\d{5}$/.test(autoTrainNumber)) return;

    liveTrackModal.hidden = false;
    requestAnimationFrame(ensureLiveTrackMap);

    const ltDateInput = document.getElementById("liveTrackDateInput");
    const ddmmyyyy = params.get("openTrackDate");
    if (ltDateInput && ddmmyyyy) {
      const [d, m, y] = ddmmyyyy.split("-");
      if (d && m && y) ltDateInput.value = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    }
    if (ltDateInput && !ltDateInput.value) {
      ltDateInput.value = new Date().toISOString().slice(0, 10);
    }

    liveTrackInput.value = autoTrainNumber;
    liveTrackReconnectAttempts = 0;
    startLiveTrack(autoTrainNumber);

    // Clean the query string out of the address bar (keeps the URL
    // shareable-looking and avoids re-triggering this on a plain refresh)
    // without a full navigation/reload.
    history.replaceState({}, "", location.pathname);
  })();

  // -------------------------------------------------------------
  // FEATURE: Train Delay Prediction with Explainable AI — on-demand
  // "why" for the currently-tracked train, reusing whatever this panel
  // already knows (train number, date/class from the options form, and
  // the most recently reported delay). Deliberately NOT run on every
  // WebSocket tick — SHAP's KernelExplainer takes a couple of seconds,
  // which is fine for a tap-to-explain button but would make every ~12s
  // live poll noticeably slower for no benefit (the breakdown for a
  // barely-changed input looks almost identical poll to poll anyway).
  // -------------------------------------------------------------
  document.getElementById("ltExplainBtn").addEventListener("click", async () => {
    const trainNumber = (liveTrackedTrainNumber || liveTrackInput.value.trim());
    const result = document.getElementById("ltExplainResult");
    if (!/^\d{5}$/.test(trainNumber)) {
      result.hidden = false;
      result.innerHTML = `<p class="tools-disclaimer">Track a train first (enter a number above and tap Track).</p>`;
      return;
    }
    result.hidden = false;
    result.innerHTML = `<p>Running the ensemble + SHAP attribution…</p>`;
    try {
      const date = toDDMMYYYY(document.getElementById("liveTrackDateInput").value);
      const travelClass = document.getElementById("liveTrackClassSelect").value;
      const res = await fetch("/api/delay/explain", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          train_number: trainNumber, date: date || null, travel_class: travelClass || null,
          current_delay_minutes: lastKnownDelayMinutes, include_historical: true,
        }),
      });
      const data = await res.json();

      const narrativeHtml = (data.narrative || []).map((n) => `<li><strong>${escapeHtml(n)}</strong></li>`).join("");
      const barsHtml = (data.attributions || []).map((a) => {
        const isUp = a.minutes >= 0;
        const dirClass = isUp ? "is-up" : "is-down";
        const arrow = isUp ? "▲" : "▼";
        const widthPct = Math.max(4, a.pct_of_total);
        return `
          <div class="shap-bar-row">
            <div class="shap-bar-top">
              <span class="shap-bar-label">${arrow} ${escapeHtml(a.label)}${a.is_shap ? "" : " •"}</span>
              <span class="shap-bar-minutes ${dirClass}">${isUp ? "+" : ""}${a.minutes.toFixed(1)} min</span>
            </div>
            <div class="shap-bar-track"><div class="shap-bar-fill ${dirClass}" style="width:${widthPct}%;"></div></div>
            <div class="shap-bar-pct">${a.pct_of_total}% of total attribution</div>
          </div>`;
      }).join("");
      const historicalHtml = data.historical_headline
        ? `<div class="historical-callout">📅 ${escapeHtml(data.historical_headline)}</div>` : "";
      const shapErrorHtml = data.shap_error
        ? `<p class="tools-disclaimer">Per-factor breakdown unavailable this time (${escapeHtml(data.shap_error)}) — the headline estimate is still real.</p>` : "";

      result.innerHTML = `
        <h4>~${formatDelayDuration(data.predicted_delay_minutes)} <span class="tools-badge">${escapeHtml(data.confidence)} confidence</span></h4>
        <p>Range: ${formatDelayDuration(data.predicted_delay_low_minutes)}–${formatDelayDuration(data.predicted_delay_high_minutes)}</p>
        ${historicalHtml}
        <ul class="result-list">${narrativeHtml}</ul>
        ${barsHtml}
        <div class="shap-legend">▲ Red = adds to the predicted delay · ▼ Green = reduces it. "•" marks the weather line, added on top of the model's own estimate rather than SHAP-attributed.</div>
        ${shapErrorHtml}
        <p class="tools-disclaimer">${escapeHtml(data.disclaimer || "")}</p>`;
    } catch {
      result.innerHTML = `<p class="tools-disclaimer">Couldn't reach the backend just now.</p>`;
    }
  });

  // -------------------------------------------------------------
  // FEATURE: Crowd-Sourced Train Position Reports — overlaid on THIS
  // live map (a second marker + uncertainty circle, distinct from the
  // official position marker above), plus a report button using the
  // browser's native Geolocation API. Full standalone version with a
  // leaderboard lives in 🧰 More Tools → 📡 Crowd Positions; this is the
  // "see it right on the map I'm already looking at" version.
  // -------------------------------------------------------------
  const LT_REPORTER_ID_KEY = "railwayRagReporterId";  // SAME key the More Tools panel uses — one identity, one badge count
  function getLtReporterId() {
    let id = localStorage.getItem(LT_REPORTER_ID_KEY);
    if (!id) {
      id = "web-" + Array.from({ length: 20 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
      localStorage.setItem(LT_REPORTER_ID_KEY, id);
    }
    return id;
  }

  const LT_CP_SOURCE_COLOR = {
    official_confirmed_by_crowd: "#2E8B57",
    official: "#16324F",
    crowd_sourced: "#FFB300",
    crowd_sourced_unconfirmed: "#8a93a1",
    unavailable: "#8a93a1",
  };

  async function refreshLtCrowdOverlay(trainNumber) {
    if (!liveTrackMap || !/^\d{5}$/.test(trainNumber)) return;
    try {
      const res = await fetch(`/api/crowd-position/${encodeURIComponent(trainNumber)}`);
      const data = await res.json();
      if (data.lat == null || data.lng == null) return;
      const color = LT_CP_SOURCE_COLOR[data.position_source] || "#FFB300";
      if (ltCrowdMarker) liveTrackMap.removeLayer(ltCrowdMarker);
      if (ltCrowdCircle) liveTrackMap.removeLayer(ltCrowdCircle);
      ltCrowdMarker = L.circleMarker([data.lat, data.lng], { radius: 7, color, fillColor: color, fillOpacity: 0.9, weight: 2 })
        .addTo(liveTrackMap)
        .bindPopup(`Crowd-sourced position<br>${escapeHtml(data.confidence_label || "")}`);
      if (data.uncertainty_radius_m) {
        ltCrowdCircle = L.circle([data.lat, data.lng], {
          radius: data.uncertainty_radius_m, color, fillColor: color, fillOpacity: 0.12, weight: 1,
        }).addTo(liveTrackMap);
      }
    } catch { /* non-fatal — overlay just doesn't update this tick */ }
  }

  document.getElementById("ltCrowdOverlayToggle").addEventListener("change", (e) => {
    ltCrowdOverlayEnabled = e.target.checked;
    const trainNumber = liveTrackedTrainNumber || liveTrackInput.value.trim();
    if (ltCrowdOverlayEnabled) {
      if (/^\d{5}$/.test(trainNumber)) refreshLtCrowdOverlay(trainNumber);
    } else if (liveTrackMap) {
      if (ltCrowdMarker) { liveTrackMap.removeLayer(ltCrowdMarker); ltCrowdMarker = null; }
      if (ltCrowdCircle) { liveTrackMap.removeLayer(ltCrowdCircle); ltCrowdCircle = null; }
    }
  });

  function getCurrentPositionAsync(options) {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) { reject(new Error("This browser doesn't support geolocation.")); return; }
      navigator.geolocation.getCurrentPosition(resolve, reject, options);
    });
  }

  // FEATURE: Crowd-Sourced Train Position — mobile-first GPS. Shared by
  // BOTH the one-time "Report my position" button AND the "Share my live
  // position automatically" toggle's periodic timer below — one real
  // submission path, not two copies that could drift. `silent` skips the
  // "Getting your location…" / success status text on the auto-share path
  // so it doesn't repaint the status line every 30s while the passenger is
  // looking at other parts of the panel; the badge card still updates.
  async function submitPositionReport(trainNumber, { silent = false } = {}) {
    const status = document.getElementById("ltCrowdPositionStatus");
    const badgeCard = document.getElementById("ltCrowdBadgeCard");
    if (!/^\d{5}$/.test(trainNumber)) {
      if (!silent) setStatus(status, "Track a valid 5-digit train number first.", "is-error");
      return null;
    }
    if (!silent) setStatus(status, "Getting your location…");
    try {
      const pos = await getCurrentPositionAsync({ enableHighAccuracy: true, timeout: 10000 });
      const date = toDDMMYYYY(document.getElementById("liveTrackDateInput").value);
      const res = await fetch("/api/crowd-position/report", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          train_number: trainNumber, reporter_id: getLtReporterId(),
          lat: pos.coords.latitude, lng: pos.coords.longitude,
          accuracy_meters: pos.coords.accuracy || null, date: date || null,
        }),
      });
      const result = await res.json();
      badgeCard.hidden = false;
      badgeCard.innerHTML = `<p>Reports submitted: <strong>${result.total_reports}</strong></p><p>Badge: <span class="cp-badge-pill">${result.badge ? escapeHtml(result.badge) : "None yet"}</span></p>`;
      setStatus(status, silent
        ? `Auto-shared your position just now (${result.total_reports} reports total).`
        : (result.badge
          ? `Thanks! You're a ${result.badge} (${result.total_reports} reports total).`
          : `Thanks! ${result.total_reports} report(s) submitted so far.`), "is-live");
      if (ltCrowdOverlayEnabled) refreshLtCrowdOverlay(trainNumber);
      return result;
    } catch (err) {
      if (!silent) setStatus(status, `Location permission denied or unavailable (${err.message || err}).`, "is-error");
      return null;
    }
  }

  document.getElementById("ltReportPositionBtn").addEventListener("click", () => {
    const trainNumber = liveTrackedTrainNumber || liveTrackInput.value.trim();
    submitPositionReport(trainNumber);
  });

  // -------------------------------------------------------------
  // FEATURE: Crowd-Sourced Train Position — mobile-first GPS.
  //   1. A proactive one-time-per-train prompt ("are you riding this
  //      train? share your position") instead of waiting for someone to
  //      find the standalone Crowd Positions tab on their own.
  //   2. An explicit "Share my live position automatically" toggle right
  //      on the main tracking panel — a first-class control, not a single
  //      report button — that re-submits a fresh GPS fix every 30s for as
  //      long as it's on and a train is being tracked.
  // -------------------------------------------------------------
  function maybeShowSharePositionPrompt(trainNumber) {
    if (!trainNumber) return;
    if (ltShareMyPositionEnabled) { ltSharePromptHandledForTrain = trainNumber; return; }
    if (ltSharePromptHandledForTrain === trainNumber) return;
    const promptEl = document.getElementById("ltSharePositionPrompt");
    if (promptEl) promptEl.hidden = false;
  }

  function startLtShareInterval(trainNumber) {
    stopLtShareInterval();
    if (!/^\d{5}$/.test(trainNumber)) return;
    submitPositionReport(trainNumber, { silent: true }); // share immediately, don't wait out the first 30s
    ltShareIntervalId = setInterval(() => {
      const current = liveTrackedTrainNumber || liveTrackInput.value.trim();
      if (!ltShareMyPositionEnabled || !/^\d{5}$/.test(current)) return;
      submitPositionReport(current, { silent: true });
    }, LT_SHARE_INTERVAL_MS);
  }

  function stopLtShareInterval() {
    if (ltShareIntervalId) { clearInterval(ltShareIntervalId); ltShareIntervalId = null; }
  }

  document.getElementById("ltShareMyPositionToggle").addEventListener("change", (e) => {
    ltShareMyPositionEnabled = e.target.checked;
    const trainNumber = liveTrackedTrainNumber || liveTrackInput.value.trim();
    const label = document.getElementById("ltShareMyPositionLabel");
    const note = document.getElementById("ltShareMyPositionNote");
    const promptEl = document.getElementById("ltSharePositionPrompt");
    if (ltShareMyPositionEnabled) {
      if (label) label.classList.add("is-active");
      if (note) {
        note.hidden = false;
        note.textContent = `Sharing your live position automatically every ${LT_SHARE_INTERVAL_MS / 1000}s while tracking — thanks for helping other passengers.`;
      }
      if (promptEl) promptEl.hidden = true;
      ltSharePromptHandledForTrain = trainNumber;
      startLtShareInterval(trainNumber);
    } else {
      if (label) label.classList.remove("is-active");
      if (note) note.hidden = true;
      stopLtShareInterval();
    }
  });

  document.getElementById("ltSharePositionPromptYes").addEventListener("click", () => {
    const toggle = document.getElementById("ltShareMyPositionToggle");
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
  });

  document.getElementById("ltSharePositionPromptDismiss").addEventListener("click", () => {
    const promptEl = document.getElementById("ltSharePositionPrompt");
    if (promptEl) promptEl.hidden = true;
    ltSharePromptHandledForTrain = liveTrackedTrainNumber || liveTrackInput.value.trim();
  });

  // -------------------------------------------------------------
  // FEATURE: Dynamic Re-route Suggestions During Live Tracking — see
  // backend/reroute_suggestions.py + app.py's /ws/track payload field
  // `reroute_suggestion`. Renders the alert card wired up near the top of
  // the Live Tracking panel (see renderRerouteAlert call in onmessage).
  // -------------------------------------------------------------
  function renderRerouteAlert(reroute) {
    const el = document.getElementById("ltRerouteAlert");
    if (!el) return;
    if (!reroute || !reroute.triggered) { el.hidden = true; el.innerHTML = ""; return; }
    el.hidden = false;
    const junction = reroute.junction_name || reroute.junction_code || "the next stop";
    const destination = reroute.destination_name || reroute.destination_code || "your destination";
    const directHtml = (reroute.direct_alternatives || []).map((t) => `
      <li><strong>${escapeHtml(t.train_number)}</strong>${t.train_name ? ` — ${escapeHtml(t.train_name)}` : ""} · dep ${escapeHtml(t.departure_time || "?")} → arr ${escapeHtml(t.arrival_time || "?")}${t.classes && t.classes.length ? ` <span class="result-tag">${escapeHtml(t.classes.join(", "))}</span>` : ""}</li>
    `).join("");
    const altRoutesHtml = (reroute.alternative_routes || []).map((r) => `
      <li>Via ${escapeHtml(r.via_names.join(" → "))} — ${r.hops} change(s), ~${r.total_distance_km} km</li>
    `).join("");
    el.innerHTML = `
      <h4>⚠️ Running ${formatDelayDuration(reroute.delay_minutes_used)} late (${escapeHtml(reroute.delay_source || "")}) — re-route suggestion</h4>
      <p>${escapeHtml(reroute.note || "")}</p>
      ${directHtml ? `<p class="explain-text__lead">Alternative trains from ${escapeHtml(junction)} to ${escapeHtml(destination)}:</p><ul class="result-list">${directHtml}</ul>` : ""}
      ${altRoutesHtml ? `<p class="explain-text__lead">Junction-hopping corridors from ${escapeHtml(junction)} (no single confirmed train for every leg):</p><ul class="result-list">${altRoutesHtml}</ul>` : ""}
      ${reroute.disclaimer ? `<p class="tools-disclaimer">${escapeHtml(reroute.disclaimer)}</p>` : ""}
    `;
  }

  // -------------------------------------------------------------
  // FEATURE: Route-Deviation/Diversion Detection — see backend/route_deviation.py.
  // -------------------------------------------------------------
  function renderDeviationAlert(deviation) {
    const el = document.getElementById("ltDeviationAlert");
    if (!el) return;
    if (!deviation || !deviation.likely_diversion) { el.hidden = true; el.innerHTML = ""; return; }
    el.hidden = false;
    el.innerHTML = `
      <h4>🚧 Possible diversion detected</h4>
      <p>${escapeHtml(deviation.note || "")}</p>
      <p class="tools-disclaimer">${escapeHtml(deviation.disclaimer || "")}</p>
    `;
  }

  // -------------------------------------------------------------
  // FEATURE: a small live delay-trend sparkline — rolling ~20-poll buffer,
  // rendered as a tiny inline canvas line (no charting library needed).
  // -------------------------------------------------------------
  function updateLtSparkline(value) {
    ltDelaySparkline.push(value);
    if (ltDelaySparkline.length > LT_SPARKLINE_MAX_POINTS) ltDelaySparkline.shift();
    renderLtSparkline();
  }

  function renderLtSparkline() {
    const card = document.getElementById("ltSparklineCard");
    const canvas = document.getElementById("ltSparkline");
    if (!card || !canvas) return;
    if (ltDelaySparkline.length < 2) { card.hidden = true; return; }
    card.hidden = false;
    const ctx = canvas.getContext("2d");
    const w = (canvas.width = canvas.clientWidth || 300);
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const values = ltDelaySparkline;
    const min = Math.min(0, ...values);
    const max = Math.max(1, ...values);
    const range = max - min || 1;
    const stepX = w / (values.length - 1);
    const yFor = (v) => h - ((v - min) / range) * (h - 8) - 4;
    ctx.beginPath();
    values.forEach((v, i) => {
      const x = i * stepX, y = yFor(v);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    const improving = values[values.length - 1] < values[0];
    ctx.strokeStyle = improving ? "#2E8B57" : "#C1272D";
    ctx.lineWidth = 2;
    ctx.stroke();
    const lastX = (values.length - 1) * stepX, lastY = yFor(values[values.length - 1]);
    ctx.beginPath();
    ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
  }

  // -------------------------------------------------------------
  // FEATURE: End-of-Trip Summary Card (shareable) — see backend/public_share.py.
  // Built entirely from figures ALREADY shown live during tracking (the
  // same per-station timeline the stop-list/chart render from) — nothing
  // here is recomputed or re-fetched, just snapshotted once the train has
  // genuinely reached its final destination.
  // -------------------------------------------------------------
  async function maybeShowTripSummary(data) {
    const key = `${data.train_number}|${data.date || ""}`;
    if (ltTripSummaryShownKey === key) return;
    ltTripSummaryShownKey = key;

    const stoppages = (data.timeline || []).filter((s) => s.kind !== "intermediate");
    if (stoppages.length < 2) return;
    const origin = stoppages[0];
    const destination = stoppages[stoppages.length - 1];

    function delayOf(s) {
      if (s.arrival && s.arrival.delay_minutes != null) return s.arrival.delay_minutes;
      if (s.departure && s.departure.delay_minutes != null) return s.departure.delay_minutes;
      return null;
    }
    let worst = null;
    stoppages.forEach((s) => {
      const d = delayOf(s);
      if (d != null && (!worst || d > worst.delay_minutes)) worst = { name: s.name || s.code, delay_minutes: d };
    });

    const summary = {
      train_number: data.train_number,
      date: data.date,
      source_station: origin.name || origin.code,
      destination_station: destination.name || destination.code,
      departure: { scheduled: origin.departure && origin.departure.scheduled, delay_minutes: delayOf(origin) },
      arrival: { scheduled: destination.arrival && destination.arrival.scheduled, delay_minutes: delayOf(destination) },
      worst_station: worst,
      total_distance_km: destination.distance_km || null,
      per_station: stoppages.map((s) => ({ name: s.name || s.code, delay_minutes: delayOf(s) || 0 })),
      generated_at: new Date().toISOString(),
    };

    const card = document.getElementById("ltTripSummaryCard");
    if (!card) return;
    card.hidden = false;
    const arrivalText = summary.arrival.delay_minutes ? `+${summary.arrival.delay_minutes} min late` : "on time";
    card.innerHTML = `
      <h4>🏁 Trip complete — ${escapeHtml(summary.source_station)} → ${escapeHtml(summary.destination_station)}</h4>
      <p>Arrived ${arrivalText}${worst ? ` · worst delay was at ${escapeHtml(worst.name)} (+${worst.delay_minutes} min)` : ""}.</p>
      <button type="button" class="feature-form__submit-like" id="ltTripSummaryShareBtn">🔗 Share this trip recap</button>
      <span class="feature-status" id="ltTripSummaryShareStatus"></span>
    `;
    const shareBtn = document.getElementById("ltTripSummaryShareBtn");
    const shareStatus = document.getElementById("ltTripSummaryShareStatus");
    if (shareBtn) {
      shareBtn.addEventListener("click", async () => {
        try {
          const res = await ltPostJSON("/api/trip-summary", { train_number: summary.train_number, date: summary.date, summary });
          const url = `${location.origin}${res.url}`;
          if (navigator.clipboard) { try { await navigator.clipboard.writeText(url); } catch { /* clipboard may be blocked — link is still shown */ } }
          const localWarning = isPrivateOrLocalHost(location.hostname)
            ? " ⚠️ Local address — won't open for anyone outside this device/WiFi. See README: \"Sharing links publicly\"."
            : "";
          if (shareStatus) shareStatus.textContent = `Link copied: ${url}${localWarning}`;
        } catch {
          if (shareStatus) shareStatus.textContent = "Couldn't create a shareable link right now.";
        }
      });
    }
  }

  // -------------------------------------------------------------
  // FEATURE: Real-Time Per-Coach Crowding (passenger-reported) — see
  // backend/coach_crowd_store.py. Distinct from the booking-data Crowd
  // Prediction section further down and the static Coach Layout seat maps.
  // -------------------------------------------------------------
  function stopLtCoachCrowdPolling() {
    if (ltCoachCrowdIntervalId) { clearInterval(ltCoachCrowdIntervalId); ltCoachCrowdIntervalId = null; }
  }

  async function refreshLtCoachCrowd(trainNumber) {
    const list = document.getElementById("ltCoachCrowdList");
    if (!list) return;
    try {
      const res = await fetch(`/api/coach-crowd/${encodeURIComponent(trainNumber)}`);
      const data = await res.json();
      const levelEmoji = { empty: "🟢", comfortable: "🟡", crowded: "🟠", packed: "🔴" };
      if (!data.coaches || !data.coaches.length) {
        list.innerHTML = `<li class="result-list--empty">No live reports yet for this train — be the first!</li>`;
        return;
      }
      list.innerHTML = data.coaches.map((c) => `
        <li><strong>${escapeHtml(c.coach)}</strong> ${levelEmoji[c.crowd_level] || ""} ${escapeHtml(c.crowd_level)}
          <span class="result-tag">${c.report_count} report${c.report_count === 1 ? "" : "s"}${c.most_recent_seconds_ago != null ? `, ${Math.max(0, Math.round(c.most_recent_seconds_ago / 60))}m ago` : ""}</span>
        </li>
      `).join("");
    } catch { /* transient — next poll retries */ }
  }

  function startLtCoachCrowdPolling(trainNumber) {
    stopLtCoachCrowdPolling();
    refreshLtCoachCrowd(trainNumber);
    ltCoachCrowdIntervalId = setInterval(() => refreshLtCoachCrowd(trainNumber), LT_COACH_CROWD_REFRESH_MS);
  }

  const ltCoachCrowdForm = document.getElementById("ltCoachCrowdForm");
  if (ltCoachCrowdForm) {
    ltCoachCrowdForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const statusEl = document.getElementById("ltCoachCrowdStatus");
      if (!liveTrackedTrainNumber) { setStatus(statusEl, "Track a train above first.", "is-error"); return; }
      const coach = document.getElementById("ltCoachCrowdCoachInput").value.trim();
      const level = document.getElementById("ltCoachCrowdLevelSelect").value;
      try {
        const res = await ltPostJSON("/api/coach-crowd/report", {
          train_number: liveTrackedTrainNumber, coach, crowd_level: level, reporter_id: getLtReporterId(),
        });
        if (res.ok) {
          setStatus(statusEl, `Thanks — reported ${res.coach} as ${res.crowd_level}.`, "is-live");
          refreshLtCoachCrowd(liveTrackedTrainNumber);
        } else {
          setStatus(statusEl, res.error || "Couldn't submit that report.", "is-error");
        }
      } catch {
        setStatus(statusEl, "Couldn't reach the backend just now.", "is-error");
      }
    });
  }

  // -------------------------------------------------------------
  // FEATURE: Shareable Read-Only Tracking Link — opens/copies a public
  // /track/{trainNumber} URL (see backend's track_share_page route +
  // frontend/track.html) that anyone can open without signing in or
  // installing anything.
  // -------------------------------------------------------------
  // A link built from a private/local hostname (localhost, a bare LAN IP
  // like 192.168.x.x, or any RFC1918 range) only ever resolves on THIS
  // device or THIS WiFi network — someone on another network (a different
  // phone's mobile data, or a different WiFi) gets a "can't reach this
  // site" error no matter what the link's path is. This can't be fixed
  // client-side; it just means the backend itself isn't reachable from
  // the wider internet yet (see README's "Sharing links publicly" note —
  // a quick tunnel like Cloudflare Tunnel/ngrok, or a real deploy, fixes
  // it). Flagging it here so this doesn't look like a broken feature.
  function isPrivateOrLocalHost(hostname) {
    if (!hostname) return false;
    const h = hostname.toLowerCase();
    if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".local")) return true;
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return false;
    const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127;
  }

  const ltShareLinkBtn = document.getElementById("ltShareLinkBtn");
  if (ltShareLinkBtn) {
    ltShareLinkBtn.addEventListener("click", async () => {
      const statusEl = document.getElementById("ltShareLinkStatus");
      statusEl.hidden = false;
      if (!liveTrackedTrainNumber) { setStatus(statusEl, "Track a train above first.", "is-error"); return; }
      const ddmmyyyy = toDDMMYYYY(document.getElementById("liveTrackDateInput").value);
      const url = `${location.origin}/track/${encodeURIComponent(liveTrackedTrainNumber)}${ddmmyyyy ? `?date=${encodeURIComponent(ddmmyyyy)}` : ""}`;
      const localWarning = isPrivateOrLocalHost(location.hostname)
        ? " ⚠️ This is a local address — it will only open on this device/WiFi, not for someone elsewhere. See the README's \"Sharing links publicly\" section to expose this server with a real public URL first."
        : "";
      try {
        if (navigator.clipboard) await navigator.clipboard.writeText(url);
        setStatus(statusEl, `Link copied — share it with anyone: ${url}${localWarning}`, localWarning ? "is-error" : "is-live");
      } catch {
        setStatus(statusEl, `Share this link: ${url}${localWarning}`);
      }
    });
  }

  // -------------------------------------------------------------
  // FEATURE: Lite/Text-Only Tracking Mode — hides the map + delay chart
  // (no tiles/canvas rendering) for slow/patchy connections. Everything
  // that's still shown (stats, stop list, sparkline, alerts) is already
  // part of the same websocket payload, so this is purely a rendering
  // choice — no extra backend call needed.
  // -------------------------------------------------------------
  const ltLiteModeToggle = document.getElementById("ltLiteModeToggle");
  if (ltLiteModeToggle) {
    ltLiteModeToggle.addEventListener("change", () => {
      ltLiteModeOn = ltLiteModeToggle.checked;
      if (liveTrackModal) liveTrackModal.classList.toggle("lt-lite-mode", ltLiteModeOn);
    });
  }

  // -------------------------------------------------------------
  // FEATURE: "Train on map" / "Delay chart" show-on-demand toggles — both
  // sections start collapsed (see the `hidden` attribute on their
  // containers in index.html) so the panel opens compact; each button
  // reveals its own section and relabels itself to "Hide ...". Leaflet/
  // Chart.js both need a nudge (invalidateSize/resize) right after being
  // un-hidden, since they were sized against a zero-height container while
  // hidden — same pattern already used for offlineMap/cpMap/tlMap elsewhere
  // in this file.
  // -------------------------------------------------------------
  const liveTrackMapWrap = document.getElementById("liveTrackMapWrap");
  const ltToggleMapBtn = document.getElementById("ltToggleMapBtn");
  if (ltToggleMapBtn && liveTrackMapWrap) {
    ltToggleMapBtn.addEventListener("click", () => {
      const showing = liveTrackMapWrap.hidden; // about to reveal it
      liveTrackMapWrap.hidden = !showing;
      ltToggleMapBtn.textContent = showing ? "🗺️ Hide train on map" : "🗺️ Train on map";
      if (showing) {
        ensureLiveTrackMap();
        setTimeout(() => liveTrackMap && liveTrackMap.invalidateSize(), 50);
      }
    });
  }

  const liveTrackChartCard = document.getElementById("liveTrackChartCard");
  const ltToggleChartBtn = document.getElementById("ltToggleChartBtn");
  if (ltToggleChartBtn && liveTrackChartCard) {
    ltToggleChartBtn.addEventListener("click", () => {
      const showing = liveTrackChartCard.hidden;
      liveTrackChartCard.hidden = !showing;
      ltToggleChartBtn.textContent = showing ? "📊 Hide delay chart" : "📊 Delay chart";
      if (showing && liveTrackChart) {
        setTimeout(() => liveTrackChart.resize(), 50);
      }
    });
  }

  // -------------------------------------------------------------
  // FEATURE: Connection-Risk Alert — see backend/connection_risk.py.
  // -------------------------------------------------------------
  async function checkPnrConnectionPrompt(primaryTrainNumber) {
    const promptEl = document.getElementById("ltConnectionPnrPrompt");
    if (!promptEl) return;
    promptEl.hidden = true;
    let watchlist = [];
    try { watchlist = JSON.parse(localStorage.getItem("pnrWatchlist")) || []; } catch { watchlist = []; }
    if (!watchlist.length) return;
    // Client-held PNR watchlist entries only store {pnr, label} (see PNR
    // Tracking) — resolve each one's real train number via the same
    // public PNR-status lookup that tool itself uses, so this stays a
    // real cross-check, never a guess.
    for (const entry of watchlist.slice(0, 8)) {
      try {
        const res = await fetch(`/api/pnr/status/${encodeURIComponent(entry.pnr)}`);
        const data = await res.json();
        if (data.train_number && String(data.train_number).trim() && String(data.train_number).trim() !== String(primaryTrainNumber).trim()) {
          promptEl.hidden = false;
          promptEl.innerHTML = `
            <h4>🔀 Connecting train on file?</h4>
            <p>Your watched PNR ${escapeHtml(entry.pnr)} is for train ${escapeHtml(data.train_number)}${data.from_station ? ` from ${escapeHtml(data.from_station)}` : ""} — check the connection risk against the train you're tracking now?</p>
            <button type="button" class="feature-form__submit-like" id="ltConnectionPnrUseBtn">Check this connection</button>
          `;
          const useBtn = document.getElementById("ltConnectionPnrUseBtn");
          if (useBtn) {
            useBtn.addEventListener("click", () => {
              document.getElementById("ltConnectionTrainInput").value = data.train_number;
              if (data.from_station) document.getElementById("ltConnectionStationInput").value = data.from_station;
              promptEl.hidden = true;
            });
          }
          return; // first match is enough — don't stack multiple prompts
        }
      } catch { /* a single bad PNR lookup shouldn't block checking the rest */ }
    }
  }

  const ltConnectionForm = document.getElementById("ltConnectionForm");
  if (ltConnectionForm) {
    ltConnectionForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const statusEl = document.getElementById("ltConnectionStatus");
      const resultEl = document.getElementById("ltConnectionResult");
      if (!liveTrackedTrainNumber) { setStatus(statusEl, "Track a train above first.", "is-error"); return; }
      const station = document.getElementById("ltConnectionStationInput").value.trim().toUpperCase();
      const connectingTrain = document.getElementById("ltConnectionTrainInput").value.trim();
      const connIsoDate = document.getElementById("ltConnectionDateInput").value;
      const primaryIsoDate = document.getElementById("liveTrackDateInput").value;
      setStatus(statusEl, "Checking real live timings for both trains…");
      resultEl.hidden = true;
      try {
        const risk = await ltPostJSON("/api/advanced/connection-risk", {
          primary_train_number: liveTrackedTrainNumber,
          primary_date: toDDMMYYYY(primaryIsoDate),
          interchange_station: station,
          connecting_train_number: connectingTrain,
          connecting_date: toDDMMYYYY(connIsoDate) || toDDMMYYYY(primaryIsoDate),
        });
        if (!risk.found) {
          setStatus(statusEl, risk.note || "Couldn't compute a connection risk right now.", "is-error");
          return;
        }
        setStatus(statusEl, "");
        const levelLabel = { missed: "🔴 Likely missed", at_risk: "🟠 At risk", tight: "🟡 Tight", comfortable: "🟢 Comfortable" };
        resultEl.hidden = false;
        resultEl.innerHTML = `
          <h4>${levelLabel[risk.risk_level] || "Connection risk"}</h4>
          <p>${escapeHtml(risk.note || "")}</p>
          <p class="explain-text">Arrival: ${escapeHtml(risk.primary_arrival || "—")} (${escapeHtml(risk.primary_arrival_basis || "")}) · Connecting departure: ${escapeHtml(risk.connecting_departure || "—")} (${escapeHtml(risk.connecting_departure_basis || "")})</p>
          <p class="tools-disclaimer">${escapeHtml(risk.disclaimer || "")}</p>
        `;
      } catch {
        setStatus(statusEl, "Couldn't reach the backend just now.", "is-error");
      }
    });
  }

  // -------------------------------------------------------------
  // FEATURE: Track Two Trains Side by Side — a self-contained pair of
  // mini live-tracking widgets, each with its OWN websocket connection.
  // Deliberately independent of every ltXxx variable above (own sockets,
  // own DOM ids) so it can never regress the primary single-train tracker.
  // -------------------------------------------------------------
  (function initCompareTrains() {
    const btn = document.getElementById("ltCompareTrainsBtn");
    const modal = document.getElementById("compareTrainsModal");
    const closeBtn = document.getElementById("compareTrainsClose");
    if (!btn || !modal) return;
    wireModal(btn, modal, closeBtn);

    const sockets = { 1: null, 2: null };

    function renderCompareHeadline(slot, data) {
      const el = document.getElementById(`compareHeadline${slot}`);
      if (!el) return;
      if (!data || data.error) {
        el.innerHTML = `<p class="explain-text">${data && data.error ? escapeHtml(data.error) : "Waiting for data…"}</p>`;
        return;
      }
      const delayText = data.delay_minutes != null ? formatDelayDuration(data.delay_minutes)
        : (data.predicted_delay_minutes != null ? `~${formatDelayDuration(data.predicted_delay_minutes)} (predicted)` : "Unknown");
      el.innerHTML = `
        <dl class="stat-grid">
          <dt>Current station</dt><dd>${escapeHtml(data.current_station || "—")}</dd>
          <dt>Next station</dt><dd>${escapeHtml(data.next_station || "—")}</dd>
          <dt>Delay</dt><dd>${escapeHtml(delayText)}</dd>
          <dt>Next station ETA</dt><dd>${escapeHtml(data.next_station_live_eta || data.next_station_expected_arrival || "—")}</dd>
          <dt>Distance remaining</dt><dd>${data.distance_remaining_to_next_km != null ? data.distance_remaining_to_next_km + " km" : "—"}</dd>
        </dl>
      `;
    }

    function connectSlot(slot, trainNumber) {
      if (sockets[slot]) { try { sockets[slot].close(); } catch {} sockets[slot] = null; }
      const statusEl = document.getElementById(`compareStatus${slot}`);
      setStatus(statusEl, `Connecting to live feed for train ${trainNumber}…`);
      let socket;
      try {
        socket = new WebSocket(`${WS_BASE}/ws/track/${encodeURIComponent(trainNumber)}`);
      } catch {
        setStatus(statusEl, "Could not open a WebSocket connection.", "is-error");
        return;
      }
      sockets[slot] = socket;
      socket.onopen = () => setStatus(statusEl, `Live — streaming updates for train ${trainNumber}`, "is-live");
      socket.onclose = () => { if (sockets[slot] === socket) sockets[slot] = null; };
      socket.onerror = () => setStatus(statusEl, "Connection error.", "is-error");
      socket.onmessage = (event) => {
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        renderCompareHeadline(slot, data);
      };
    }

    [1, 2].forEach((slot) => {
      const form = document.getElementById(`compareForm${slot}`);
      const input = document.getElementById(`compareInput${slot}`);
      if (form) {
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          const trainNumber = input.value.trim();
          if (trainNumber) connectSlot(slot, trainNumber);
        });
      }
    });

    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        [1, 2].forEach((slot) => { if (sockets[slot]) { try { sockets[slot].close(); } catch {} sockets[slot] = null; } });
      }
    });
    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        [1, 2].forEach((slot) => { if (sockets[slot]) { try { sockets[slot].close(); } catch {} sockets[slot] = null; } });
      });
    }
  })();

  // -------------------------------------------------------------
  // FEATURE: Train Search (source/dest/date/time, paginated 1-50/page)
  // -------------------------------------------------------------
  const trainSearchBtn = document.getElementById("trainSearchBtn");
  const trainSearchModal = document.getElementById("trainSearchModal");
  const trainSearchClose = document.getElementById("trainSearchClose");
  const trainSearchForm = document.getElementById("trainSearchForm");
  const trainSearchSource = document.getElementById("trainSearchSource");
  const trainSearchDest = document.getElementById("trainSearchDest");
  const trainSearchDate = document.getElementById("trainSearchDate");
  const trainSearchClass = document.getElementById("trainSearchClass");
  const trainSearchQuota = document.getElementById("trainSearchQuota");
  const trainSearchAvailableOnly = document.getElementById("trainSearchAvailableOnly");
  const trainSearchWaitlistedOnly = document.getElementById("trainSearchWaitlistedOnly");
  const trainSearchLimit = document.getElementById("trainSearchLimit");
  const trainSearchStatus = document.getElementById("trainSearchStatus");
  const trainSearchResults = document.getElementById("trainSearchResults");
  const trainSearchPagination = document.getElementById("trainSearchPagination");
  const trainSearchPageInfo = document.getElementById("trainSearchPageInfo");
  const trainSearchPrev = document.getElementById("trainSearchPrev");
  const trainSearchNext = document.getElementById("trainSearchNext");

  let trainSearchState = { page: 1, totalPages: 1 };

  wireModal(trainSearchBtn, trainSearchModal, trainSearchClose);

  // -------------------------------------------------------------
  // IRCTC-style departure/arrival time-band picker: 4 quick buttons
  // (00-06/06-12/12-18/18-00) or a "Custom" toggle revealing a
  // From/To pair (To left blank = a single point-in-time entry).
  // -------------------------------------------------------------
  function wireTimeBandGroup(groupEl) {
    const buttons = Array.from(groupEl.querySelectorAll(".time-band-btn:not(.time-band-btn--custom)"));
    const customToggle = groupEl.querySelector('[data-custom-toggle="true"]');
    const customPanel = groupEl.querySelector(".time-band-custom");
    const fromInput = groupEl.querySelector(".time-band-custom__from");
    const toInput = groupEl.querySelector(".time-band-custom__to");
    let selected = { start: null, end: null };

    function clearActive() {
      buttons.forEach((b) => b.classList.remove("is-active"));
      customToggle.classList.remove("is-active");
    }

    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        clearActive();
        btn.classList.add("is-active");
        customPanel.hidden = true;
        fromInput.value = "";
        toInput.value = "";
        selected = { start: btn.dataset.start, end: btn.dataset.end };
      });
    });

    customToggle.addEventListener("click", () => {
      customPanel.hidden = !customPanel.hidden;
      if (!customPanel.hidden) {
        clearActive();
        customToggle.classList.add("is-active");
      }
    });

    function syncFromCustomInputs() {
      clearActive();
      customToggle.classList.add("is-active");
      selected = { start: fromInput.value || null, end: toInput.value || fromInput.value || null };
    }
    fromInput.addEventListener("change", syncFromCustomInputs);
    toInput.addEventListener("change", syncFromCustomInputs);

    return {
      getValue: () => selected,
      reset: () => {
        clearActive();
        customPanel.hidden = true;
        fromInput.value = "";
        toInput.value = "";
        selected = { start: null, end: null };
      },
    };
  }

  const departureBand = wireTimeBandGroup(document.getElementById("departureBandGroup"));
  const arrivalBand = wireTimeBandGroup(document.getElementById("arrivalBandGroup"));

  // -------------------------------------------------------------
  // Per-field Reset buttons — every Search Trains field (From, To,
  // Date, Class, Quota, Per page, both checkboxes, both time-band
  // groups) gets its own "reset" link that clears just that field
  // back to its own default, independent of the rest of the form.
  // Plain inputs/selects/number just get their value put back;
  // checkboxes get unchecked; time bands reuse wireTimeBandGroup's
  // own reset(). For fields with an existing auto-search "change"
  // listener (class/quota/both checkboxes), a real change event is
  // dispatched so resetting behaves exactly like the user picking
  // that value by hand — same re-search behavior, no duplicated logic.
  //
  // Every reset also clears the results panel (status text, train
  // list, pagination) from whatever was last searched, so a reset
  // field never leaves a stale note from the PREVIOUS search on
  // screen (e.g. clearing the time band still showing "no trains
  // matched that departure/arrival time" even though no time is set
  // anymore).
  // -------------------------------------------------------------
  function clearStaleTrainSearchResults() {
    setStatus(trainSearchStatus, "");
    trainSearchResults.innerHTML = "";
    trainSearchPagination.hidden = true;
  }
  document.querySelectorAll("#trainSearchForm .field-reset-btn[data-reset], .time-band-row .field-reset-btn[data-reset]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const el = document.getElementById(btn.dataset.reset);
      if (!el) return;
      if (el.type === "checkbox") {
        el.checked = false;
      } else {
        el.value = btn.dataset.resetValue ?? "";
      }
      clearStaleTrainSearchResults();
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
  });
  document.querySelectorAll(".field-reset-btn[data-reset-band]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      (btn.dataset.resetBand === "departure" ? departureBand : arrivalBand).reset();
      clearStaleTrainSearchResults();
    });
  });


  function ddmmyyyy(isoDate) {
    if (!isoDate) return null;
    const [y, m, d] = isoDate.split("-");
    return `${d}-${m}-${y}`;
  }

  function availabilityBadge(t) {
    if (t.availability_error) return `<span class="availability-badge is-unknown">Availability unavailable</span>`;
    if (!t.availability_status) return "";
    const text = t.availability_status;
    let cls = "is-unknown";
    if (/\bAVAILABLE\b/i.test(text)) cls = "is-available";
    else if (/\bWL\b|\bWAITLIST/i.test(text)) cls = "is-waitlist";
    else if (/\bRAC\b/i.test(text)) cls = "is-rac";
    return `<span class="availability-badge ${cls}">${escapeHtml(text)}</span>`;
  }

  // FEATURE: fare-on-every-result (was previously only shown in the
  // separate Route Compare / Fare Heatmap tools) — see the backend's
  // fare_note for the honest caveat text (needs a class picked, and only
  // the first few trains get a live RailKit fare lookup per page).
  function fareBadge(t) {
    if (t.fare != null) {
      return `<span class="availability-badge is-unknown" title="Estimate from RailKit (third-party), not live IRCTC Tatkal/Premium Tatkal pricing.">₹${escapeHtml(String(t.fare))}${t.quota ? ` (${escapeHtml(t.quota)})` : ""}</span>`;
    }
    if (t.fare_error) return `<span class="availability-badge is-unknown">Fare unavailable</span>`;
    return "";
  }

  // CROWD-POSITION FOLLOW-UP: IRCTC's search page has no supported URL
  // params to prefill (checked, not assumed — see the button's own title
  // text). The honest next-best thing is copying the trip details to the
  // clipboard right before IRCTC opens, so they can be pasted into
  // IRCTC's own search box instead of retyped from memory.
  function bookingSummary(t, { source, dest, date, travelClass, quota }) {
    const parts = [
      `Train ${t.train_number}${t.train_name ? ` (${t.train_name})` : ""}`,
      source && dest ? `${source} → ${dest}` : null,
      date ? `Date: ${date}` : null,
      travelClass ? `Class: ${travelClass}` : null,
      quota ? `Quota: ${quota}` : null,
    ].filter(Boolean);
    return parts.join(" · ");
  }

  async function handleBookOnIrctcClick(e) {
    const btn = e.target.closest(".train-row__book-btn");
    if (!btn) return;
    e.preventDefault();
    const summary = btn.dataset.summary || "";
    try {
      if (navigator.clipboard && summary) {
        await navigator.clipboard.writeText(summary);
        setStatus(trainSearchStatus, `Trip details copied (${summary}) — paste them into IRCTC's search. Opening IRCTC…`);
      }
    } catch (_) {
      // Clipboard can fail (permissions, non-HTTPS context, etc.) — still
      // let the real hand-off through, just without the copy-assist.
    }
    window.open("https://www.irctc.co.in/nget/train-search", "_blank", "noopener");
  }
  if (trainSearchResults) trainSearchResults.addEventListener("click", handleBookOnIrctcClick);

  async function runTrainSearch(page) {
    const source = trainSearchSource.value.trim();
    const dest = trainSearchDest.value.trim();
    if (!source || !dest) return;
    let limit = parseInt(trainSearchLimit.value, 10);
    if (!Number.isFinite(limit)) limit = 10;
    limit = Math.max(1, Math.min(50, limit));
    trainSearchLimit.value = limit;
    const travelClass = trainSearchClass.value || null;
    const quota = trainSearchQuota.value || "GN";

    setStatus(trainSearchStatus, "Searching…");
    trainSearchResults.innerHTML = "";
    trainSearchPagination.hidden = true;

    try {
      const res = await fetch("/api/trains/search", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source, dest,
          date: ddmmyyyy(trainSearchDate.value) || null,
          time: null,
          departure_start: departureBand.getValue().start,
          departure_end: departureBand.getValue().end,
          arrival_start: arrivalBand.getValue().start,
          arrival_end: arrivalBand.getValue().end,
          travel_class: travelClass, quota,
          available_only: !!trainSearchAvailableOnly.checked,
          waitlisted_only: !!trainSearchWaitlistedOnly.checked,
          limit, page: page || 1,
        }),
      });
      const data = await res.json();

      if (data.error && !data.total) {
        setStatus(trainSearchStatus, data.error, "is-error");
        trainSearchResults.innerHTML = `<li class="result-list--empty">No trains to show.</li>`;
        return;
      }

      let statusMsg = `${data.total} train${data.total === 1 ? "" : "s"} found — showing page ${data.page} of ${data.total_pages} (${limit}/page)`;
      if (data.travel_class) statusMsg += ` · class ${data.travel_class} · quota ${data.quota}`;
      if (data.availability_note) statusMsg += ` — ${data.availability_note}`;
      if (data.fare_note) statusMsg += ` · 💰 ${data.fare_note}`;
      setStatus(trainSearchStatus, statusMsg);
      [data.running_date_note, data.time_filter_note, data.class_filter_note, data.confirmed_absent_note, data.parse_diagnostic_note].filter(Boolean).forEach((msg) => {
        const note = document.createElement("li");
        note.className = "result-list--empty";
        note.textContent = msg;
        trainSearchResults.appendChild(note);
      });

      data.trains.forEach((t) => {
        const li = document.createElement("li");
        const timing = [t.source_departure ? `dep ${t.source_departure}` : null, t.dest_arrival ? `arr ${t.dest_arrival}` : null, t.duration ? `${t.duration}` : null]
          .filter(Boolean).join(" · ");
        const classChips = (t.classes && t.classes.length)
          ? `<div class="train-row__classes">${t.classes.map((c) => `<span class="class-chip ${travelClass && c.trim().toUpperCase() === travelClass ? "is-selected" : ""}">${escapeHtml(c)}</span>`).join("")}</div>`
          : "";
        const summary = bookingSummary(t, { source, dest, date: trainSearchDate.value ? ddmmyyyy(trainSearchDate.value) : null, travelClass, quota });
        li.innerHTML = `
          <div class="train-row__main">
            <span><strong>${escapeHtml(String(t.train_number))}</strong> — ${escapeHtml(t.train_name || "")}${timing ? ` <span>(${escapeHtml(timing)})</span>` : ""}</span>
            ${classChips}
          </div>
          ${availabilityBadge(t)}
          ${fareBadge(t)}
          <button type="button" class="train-row__book-btn" data-summary="${escapeHtml(summary)}" title="Opens IRCTC's official booking site — this app shows real train info but can't book tickets itself, so booking happens on IRCTC directly. Trip details are copied to your clipboard first since IRCTC has no supported way to pre-fill them via a link.">🎫 Book on IRCTC</button>`;
        trainSearchResults.appendChild(li);
      });

      trainSearchState = { page: data.page, totalPages: data.total_pages };
      trainSearchPageInfo.textContent = `Page ${data.page} of ${data.total_pages}`;
      trainSearchPrev.disabled = data.page <= 1;
      trainSearchNext.disabled = data.page >= data.total_pages;
      trainSearchPagination.hidden = data.total_pages <= 1;
    } catch {
      setStatus(trainSearchStatus, "Couldn't reach the backend just now.", "is-error");
    }
  }

  trainSearchForm.addEventListener("submit", (e) => {
    e.preventDefault();
    runTrainSearch(1);
  });
  // Behave like a real filter — re-run the search automatically the
  // moment class or quota changes (source/dest/date/time still need the
  // explicit Search click, same as IRCTC, since those are the expensive
  // /search-between-stations call, not just a re-filter of what's shown).
  trainSearchClass.addEventListener("change", () => {
    if (trainSearchSource.value.trim() && trainSearchDest.value.trim()) runTrainSearch(1);
  });
  trainSearchQuota.addEventListener("change", () => {
    if (trainSearchClass.value && trainSearchSource.value.trim() && trainSearchDest.value.trim()) runTrainSearch(1);
  });
  trainSearchAvailableOnly.addEventListener("change", () => {
    if (trainSearchClass.value && trainSearchDate.value && trainSearchSource.value.trim() && trainSearchDest.value.trim()) runTrainSearch(1);
  });
  trainSearchWaitlistedOnly.addEventListener("change", () => {
    if (trainSearchClass.value && trainSearchDate.value && trainSearchSource.value.trim() && trainSearchDest.value.trim()) runTrainSearch(1);
  });
  trainSearchPrev.addEventListener("click", () => {
    if (trainSearchState.page > 1) runTrainSearch(trainSearchState.page - 1);
  });
  trainSearchNext.addEventListener("click", () => {
    if (trainSearchState.page < trainSearchState.totalPages) runTrainSearch(trainSearchState.page + 1);
  });

  // -------------------------------------------------------------
  // FEATURE: Semantic Station Search with Geo-Coding
  // -------------------------------------------------------------
  const stationSearchBtn = document.getElementById("stationSearchBtn");
  const stationSearchModal = document.getElementById("stationSearchModal");
  const stationSearchClose = document.getElementById("stationSearchClose");
  const stationSearchForm = document.getElementById("stationSearchForm");
  const stationSearchInput = document.getElementById("stationSearchInput");
  const stationSearchStatus = document.getElementById("stationSearchStatus");
  const stationSearchResults = document.getElementById("stationSearchResults");
  const stationSearchCaption = document.getElementById("stationSearchCaption");

  let stationSearchMap = null;
  let stationSearchMarkers = [];

  function ensureStationSearchMap() {
    if (stationSearchMap || typeof L === "undefined") return;
    stationSearchMap = L.map("stationSearchMap", { scrollWheelZoom: false }).setView([22.5, 79], 5);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors", maxZoom: 18,
    }).addTo(stationSearchMap);
  }

  wireModal(stationSearchBtn, stationSearchModal, stationSearchClose, () => requestAnimationFrame(ensureStationSearchMap));

  stationSearchForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const query = stationSearchInput.value.trim();
    if (!query) return;
    setStatus(stationSearchStatus, "Searching…");
    stationSearchResults.innerHTML = "";
    try {
      const res = await fetch("/api/stations/search", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, top_k: 6 }),
      });
      const data = await res.json();
      setStatus(stationSearchStatus, data.note || `${data.matches.length} match(es) — semantic engine: ${data.engine}`);

      ensureStationSearchMap();
      stationSearchMarkers.forEach((m) => stationSearchMap.removeLayer(m));
      stationSearchMarkers = [];
      const points = [];

      if (!data.matches.length) {
        stationSearchResults.innerHTML = `<li class="result-list--empty">No matches found.</li>`;
      }
      data.matches.forEach((m) => {
        const li = document.createElement("li");
        li.innerHTML = `<span><strong>${escapeHtml(m.name)}</strong> (${escapeHtml(m.code)})</span><span class="result-tag">${escapeHtml(m.matched_on)} · ${m.score}</span>`;
        stationSearchResults.appendChild(li);
        if (m.lat != null && m.lng != null && stationSearchMap) {
          const marker = L.marker([m.lat, m.lng]).addTo(stationSearchMap).bindPopup(`${escapeHtml(m.name)} (${escapeHtml(m.code)})`);
          stationSearchMarkers.push(marker);
          points.push([m.lat, m.lng]);
        }
      });
      if (points.length === 1) {
        stationSearchMap.setView(points[0], 8);
        stationSearchCaption.textContent = "Geo-coded from the curated station coordinate table.";
      } else if (points.length > 1) {
        stationSearchMap.fitBounds(points, { padding: [30, 30] });
        stationSearchCaption.textContent = "Geo-coded from the curated station coordinate table.";
      } else {
        stationSearchCaption.textContent = "No coordinates to plot.";
      }
    } catch {
      setStatus(stationSearchStatus, "Couldn't reach the backend just now.", "is-error");
    }
  });

  // -------------------------------------------------------------
  // FEATURE: Advanced Charting & Analytics Dashboard
  // -------------------------------------------------------------
  const dashboardBtn = document.getElementById("dashboardBtn");
  const dashboardModal = document.getElementById("dashboardModal");
  const dashboardClose = document.getElementById("dashboardClose");
  const dashboardStatus = document.getElementById("dashboardStatus");
  const dashStats = document.getElementById("dashStats");

  let chartIntent = null, chartDelay = null, chartCrowd = null;
  let dashboardTimer = null;

  async function refreshDashboard() {
    if (typeof Chart === "undefined") {
      setStatus(dashboardStatus, "Chart library failed to load.", "is-error");
      return;
    }
    try {
      const res = await fetch("/api/analytics/summary");
      const data = await res.json();
      setStatus(dashboardStatus, `${data.total_events} event(s) logged this session · ${data.note}`);

      const intentLabels = Object.keys(data.intent_distribution);
      const intentValues = Object.values(data.intent_distribution);
      const intentCtx = document.getElementById("chartIntent");
      if (chartIntent) chartIntent.destroy();
      chartIntent = new Chart(intentCtx, {
        type: "bar",
        data: { labels: intentLabels, datasets: [{ label: "Requests", data: intentValues, backgroundColor: "#16324F" }] },
        options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
      });

      const delayLabels = data.delay_series.map((d) => new Date(d.t).toLocaleTimeString());
      const delayCtx = document.getElementById("chartDelay");
      if (chartDelay) chartDelay.destroy();
      chartDelay = new Chart(delayCtx, {
        type: "line",
        data: {
          labels: delayLabels,
          datasets: [
            { label: "Actual (min)", data: data.delay_series.map((d) => d.actual), borderColor: "#C1272D", spanGaps: true, tension: 0.25 },
            { label: "ML predicted (min)", data: data.delay_series.map((d) => d.predicted), borderColor: "#FFB300", spanGaps: true, tension: 0.25 },
          ],
        },
        options: { scales: { y: { beginAtZero: true } } },
      });

      const crowdLabels = data.crowd_series.map((d) => new Date(d.t).toLocaleTimeString());
      const crowdCtx = document.getElementById("chartCrowd");
      if (chartCrowd) chartCrowd.destroy();
      chartCrowd = new Chart(crowdCtx, {
        type: "line",
        data: { labels: crowdLabels, datasets: [{ label: "Crowd score (0-100)", data: data.crowd_series.map((d) => d.score), borderColor: "#2E8B57", tension: 0.25 }] },
        options: { scales: { y: { beginAtZero: true, max: 100 } } },
      });

      dashStats.innerHTML = `
        <dt>Total events</dt><dd>${data.total_events}</dd>
        <dt>Live-data error rate</dt><dd>${data.live_error_rate_pct}%</dd>
        <dt>Cache entries</dt><dd>${data.cache_stats.total_entries}</dd>
        <dt>Live (non-expired) cache entries</dt><dd>${data.cache_stats.live_entries}</dd>
      `;
    } catch {
      setStatus(dashboardStatus, "Couldn't reach the backend just now.", "is-error");
    }
  }

  wireModal(dashboardBtn, dashboardModal, dashboardClose, () => {
    refreshDashboard();
    if (!dashboardTimer) dashboardTimer = setInterval(refreshDashboard, 15000);
  });
})();
// ============================================================
// FEATURE: "More Tools" panel — Platform Predictor, Pantry Menu,
// Station Amenities, My Train Dashboard, Delay Impact Calculator,
// Coach Layout, Seat Recommender, Route Compare, Refund Estimator,
// Fare & Availability Heatmap. Self-contained IIFE with its own
// small setStatus/wireModal copies (the shared ones above are
// scoped to that earlier IIFE).
// ============================================================
(function () {
  function setStatus(el, text, kind) {
    if (!el) return;
    el.textContent = text;
    el.classList.remove("is-live", "is-error");
    if (kind) el.classList.add(kind);
  }

  function toDDMMYYYY(isoDate) {
    if (!isoDate) return "";
    const [y, m, d] = isoDate.split("-");
    return y && m && d ? `${d}-${m}-${y}` : "";
  }

  async function postJSON(url, body) {
    const res = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  // FEATURE: same "1h 10m" duration formatting as the Live Tracking tab's
  // own copy of this helper (frontend/app.js's first IIFE) - duplicated
  // here rather than shared because this More Tools panel runs in its own
  // top-level IIFE with no access to that scope's functions. Purely a
  // display transform - the underlying minutes values are unchanged.
  function formatDelayDuration(mins) {
    if (mins == null || Number.isNaN(mins)) return null;
    const sign = mins < 0 ? "-" : "";
    const abs = Math.round(Math.abs(mins));
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    if (h === 0) return `${sign}${m}m`;
    if (m === 0) return `${sign}${h}h`;
    return `${sign}${h}h ${m}m`;
  }

  const moreToolsBtn = document.getElementById("moreToolsBtn");
  const moreToolsModal = document.getElementById("moreToolsModal");
  const moreToolsClose = document.getElementById("moreToolsClose");
  if (!moreToolsBtn || !moreToolsModal) return;

  moreToolsBtn.addEventListener("click", () => { moreToolsModal.hidden = false; });
  moreToolsClose.addEventListener("click", () => { moreToolsModal.hidden = true; });
  moreToolsModal.addEventListener("click", (e) => { if (e.target === moreToolsModal) moreToolsModal.hidden = true; });

  // ---- Tab switching ----
  const tabs = Array.from(document.querySelectorAll(".tools-tab"));
  const panels = Array.from(document.querySelectorAll(".tools-panel"));
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("is-active"));
      panels.forEach((p) => p.classList.remove("is-active"));
      tab.classList.add("is-active");
      const panel = document.getElementById(`tool-${tab.dataset.tool}`);
      if (panel) panel.classList.add("is-active");
    });
  });

  // -------------------------------------------------------------
  // Platform Number Predictor
  // -------------------------------------------------------------
  document.getElementById("platformForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const trainNumber = document.getElementById("platformTrainInput").value.trim();
    const station = document.getElementById("platformStationInput").value.trim().toUpperCase();
    const status = document.getElementById("platformStatus");
    const result = document.getElementById("platformResult");
    if (!/^\d{5}$/.test(trainNumber)) { setStatus(status, "Enter a valid 5-digit train number.", "is-error"); return; }
    setStatus(status, "Estimating…");
    result.hidden = true;
    try {
      const data = await postJSON("/api/advanced/platform-predict", { train_number: trainNumber, station });
      setStatus(status, "");
      result.hidden = false;
      result.innerHTML = `
        <h4>Platform ${data.predicted_platform} <span class="tools-badge">most likely</span></h4>
        <p>Alternate possibility: Platform ${data.alternate_platform}</p>
        <p>Confidence: <strong>${escapeHtml(data.confidence)}</strong> · ${escapeHtml(station)} has ${data.station_platform_count} platforms in this model.</p>
        ${data.platform_count_note ? `<p class="tools-disclaimer">${escapeHtml(data.platform_count_note)}</p>` : ""}
        <div class="tools-disclaimer">${escapeHtml(data.disclaimer)}</div>`;
    } catch { setStatus(status, "Couldn't reach the backend just now.", "is-error"); }
  });

  // -------------------------------------------------------------
  // Pantry Car Menu
  // -------------------------------------------------------------
  document.getElementById("pantryForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const trainNumber = document.getElementById("pantryTrainInput").value.trim();
    const status = document.getElementById("pantryStatus");
    const result = document.getElementById("pantryResult");
    if (!/^\d{5}$/.test(trainNumber)) { setStatus(status, "Enter a valid 5-digit train number.", "is-error"); return; }
    setStatus(status, "Looking up…");
    result.hidden = true;
    try {
      const data = await postJSON("/api/advanced/pantry-menu", { train_number: trainNumber });
      setStatus(status, "");
      result.hidden = false;
      const badgeMap = { yes: "is-yes", likely: "is-yes", unlikely: "is-no", unknown: "" };
      const labelMap = { yes: "Pantry car likely present", likely: "Pantry car possibly present", unlikely: "Pantry car unlikely", unknown: "Pantry status unknown" };
      let menuHtml = "";
      Object.entries(data.menu).forEach(([cat, items]) => {
        menuHtml += `<div><h5>${escapeHtml(cat)}</h5><ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul></div>`;
      });
      result.innerHTML = `
        <h4>${escapeHtml(data.train_name || `Train ${trainNumber}`)}
          <span class="tools-badge ${badgeMap[data.pantry_status] || ""}">${escapeHtml(labelMap[data.pantry_status] || "")}</span>
        </h4>
        <div class="tools-menu-grid">${menuHtml}</div>
        <p>${escapeHtml(data.e_catering_note)}</p>
        <div class="tools-disclaimer">${escapeHtml(data.disclaimer)}</div>`;
    } catch { setStatus(status, "Couldn't reach the backend just now.", "is-error"); }
  });

  // -------------------------------------------------------------
  // Station Amenities
  // -------------------------------------------------------------
  document.getElementById("amenitiesForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const station = document.getElementById("amenitiesStationInput").value.trim().toUpperCase();
    const status = document.getElementById("amenitiesStatus");
    const result = document.getElementById("amenitiesResult");
    if (!station) return;
    setStatus(status, "Looking up…");
    result.hidden = true;
    try {
      const res = await fetch(`/api/advanced/station-amenities/${encodeURIComponent(station)}`);
      const data = await res.json();
      setStatus(status, "");
      result.hidden = false;
      if (!data.found) {
        result.innerHTML = `<h4>${escapeHtml(station)}</h4><p>No curated amenity data for this station yet — this list currently covers major junctions/terminals only.</p>
          <div class="tools-disclaimer">${escapeHtml(data.disclaimer)}</div>`;
        return;
      }
      const a = data.amenities;
      const badges = [
        ["Food court", a.food_court], ["Executive lounge", a.executive_lounge],
        ["Retiring rooms", a.retiring_room], ["Wi-Fi", a.wifi],
        ["Cloak room", a.cloak_room], ["Waiting room", a.waiting_room],
      ];
      result.innerHTML = `
        <h4>${escapeHtml(a.name)} (${escapeHtml(station)})</h4>
        <div class="tools-badges">${badges.map(([label, has]) => `<span class="tools-badge ${has ? "is-yes" : "is-no"}">${has ? "✓" : "✕"} ${escapeHtml(label)}</span>`).join("")}</div>
        <div class="tools-disclaimer">${escapeHtml(data.disclaimer)}</div>`;
    } catch { setStatus(status, "Couldn't reach the backend just now.", "is-error"); }
  });

  // -------------------------------------------------------------
  // "My Train" Dashboard (list kept in localStorage, refreshed via
  // one batch backend call for real live status)
  // -------------------------------------------------------------
  const MY_TRAINS_KEY = "myTrains";
  function loadMyTrains() {
    try { return JSON.parse(localStorage.getItem(MY_TRAINS_KEY) || "[]"); } catch { return []; }
  }
  function saveMyTrains(list) {
    try { localStorage.setItem(MY_TRAINS_KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
  }

  const myTrainList = document.getElementById("myTrainList");
  const myTrainStatus = document.getElementById("myTrainStatus");

  async function renderMyTrains() {
    const list = loadMyTrains();
    myTrainList.innerHTML = "";
    if (!list.length) {
      myTrainList.innerHTML = `<li class="result-list--empty">No journeys saved yet — add one above.</li>`;
      return;
    }
    setStatus(myTrainStatus, "Refreshing live status…");
    let statusByTrain = {};
    try {
      const data = await postJSON("/api/advanced/dashboard", {
        trains: list.map((t) => ({ train_number: t.trainNumber, date: t.date ? toDDMMYYYY(t.date) : null, label: t.label })),
      });
      (data.trains || []).forEach((row) => { statusByTrain[row.train_number] = row; });
      setStatus(myTrainStatus, `${list.length} saved journey${list.length === 1 ? "" : "s"}.`);
    } catch {
      setStatus(myTrainStatus, "Saved journeys shown below — couldn't refresh live status just now.", "is-error");
    }
    list.forEach((t, idx) => {
      const row = statusByTrain[t.trainNumber] || {};
      const li = document.createElement("li");
      const liveText = row.error
        ? `<span class="result-tag">live status unavailable</span>`
        : row.current_station
          ? `<span class="result-tag">at ${escapeHtml(row.current_station)}${row.delay_minutes != null ? ` · +${formatDelayDuration(row.delay_minutes)}` : ""}</span>`
          : `<span class="result-tag">no live data yet</span>`;
      li.innerHTML = `<span><strong>${escapeHtml(t.trainNumber)}</strong>${t.label ? ` — ${escapeHtml(t.label)}` : ""}${t.date ? ` <span>(${escapeHtml(t.date)})</span>` : ""}</span>${liveText}`;
      const rmBtn = document.createElement("button");
      rmBtn.className = "remove-btn"; rmBtn.type = "button"; rmBtn.setAttribute("aria-label", "Remove"); rmBtn.textContent = "×";
      rmBtn.addEventListener("click", () => {
        const updated = loadMyTrains(); updated.splice(idx, 1); saveMyTrains(updated); renderMyTrains();
      });
      li.appendChild(rmBtn);
      myTrainList.appendChild(li);
    });
  }

  document.getElementById("myTrainAddForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const trainNumber = document.getElementById("myTrainNumberInput").value.trim();
    if (!/^\d{5}$/.test(trainNumber)) { setStatus(myTrainStatus, "Enter a valid 5-digit train number.", "is-error"); return; }
    const date = document.getElementById("myTrainDateInput").value;
    const label = document.getElementById("myTrainLabelInput").value.trim();
    const list = loadMyTrains();
    list.push({ trainNumber, date, label });
    saveMyTrains(list);
    document.getElementById("myTrainAddForm").reset();
    renderMyTrains();
  });

  document.querySelector('.tools-tab[data-tool="mytrains"]').addEventListener("click", renderMyTrains);

  // -------------------------------------------------------------
  // Delay Impact Calculator (reuses /api/delay/predict, then does
  // the arrival-time / connection-risk math client-side)
  // -------------------------------------------------------------
  document.getElementById("delayImpactForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const trainNumber = document.getElementById("diTrainInput").value.trim();
    const date = toDDMMYYYY(document.getElementById("diDateInput").value);
    const station = document.getElementById("diStationInput").value.trim().toUpperCase();
    const scheduledTime = document.getElementById("diScheduledTimeInput").value;
    const buffer = parseInt(document.getElementById("diBufferInput").value, 10) || 0;
    const status = document.getElementById("delayImpactStatus");
    const result = document.getElementById("delayImpactResult");
    if (!/^\d{5}$/.test(trainNumber) || !scheduledTime) { setStatus(status, "Enter a valid train number and scheduled arrival time.", "is-error"); return; }
    setStatus(status, "Predicting delay…");
    result.hidden = true;
    try {
      const data = await postJSON("/api/delay/predict", { train_number: trainNumber, date: date || null, source: station });
      const predicted = data.predicted_delay_minutes;
      setStatus(status, "");
      result.hidden = false;
      if (predicted == null) {
        result.innerHTML = `<h4>No prediction available</h4><p>Not enough live data yet for train ${escapeHtml(trainNumber)} to predict a delay.</p>`;
        return;
      }
      const [h, m] = scheduledTime.split(":").map(Number);
      const eta = new Date(); eta.setHours(h, m + predicted, 0, 0);
      const etaStr = eta.toTimeString().slice(0, 5);
      const spare = buffer - predicted;
      const atRisk = spare < 0;
      result.innerHTML = `
        <h4>Expected arrival ≈ ${etaStr} <span class="tools-badge ${atRisk ? "is-no" : "is-yes"}">${atRisk ? "Connection at risk" : "Connection should hold"}</span></h4>
        <p>Predicted delay: <strong>${formatDelayDuration(predicted)}</strong> (range ${formatDelayDuration(data.predicted_delay_low_minutes)}–${formatDelayDuration(data.predicted_delay_high_minutes)}, confidence: ${escapeHtml(data.confidence || "n/a")})</p>
        <p>${atRisk ? `Your ${buffer}-min buffer falls short by ${Math.abs(spare)} min.` : `Your ${buffer}-min buffer leaves ${spare} min to spare.`}</p>
        <div class="tools-disclaimer">${escapeHtml(data.disclaimer || "")}</div>`;
    } catch { setStatus(status, "Couldn't reach the backend just now.", "is-error"); }
  });

  // -------------------------------------------------------------
  // Coach Layout Visualization
  // -------------------------------------------------------------
  function renderSeatBadge(seat, extraClass, occupiedSet) {
    const typeClass = { L: "is-lower", M: "is-middle", U: "is-upper", SL: "is-lower", SU: "is-upper", SM: "is-middle" }[seat.type] || "";
    // CROWD-POSITION FOLLOW-UP: "is-occupied-estimate" only ever comes
    // from the real-aggregate-based occupancy shading (see
    // estimate_seat_occupancy's disclaimer, rendered right under this
    // diagram) — never shown unless the caller actually fetched one.
    const occClass = occupiedSet && occupiedSet.has(seat.number) ? "is-occupied-estimate" : "";
    return `<div class="coach-seat ${typeClass} ${extraClass || ""} ${occClass}">${escapeHtml(String(seat.number))}</div>`;
  }

  function renderBaySeatMap(seatMap, occupiedSet) {
    const bays = seatMap.bays.slice(0, 10); // cap the diagram length; pattern repeats
    let html = `<div class="coach-diagram coach-diagram--bay">
      <div class="coach-toilets"><span>🚻 Toilet</span><span>🚻 Toilet</span></div>
      <div class="coach-entry-row"><span>◄ Coach entry/exit</span><span>Coach entry/exit ►</span></div>`;
    bays.forEach((bay) => {
      const isCabinOrCoupe = bay.is_cabin || bay.is_coupe;
      const bayLabel = (bay.is_cabin || bay.is_coupe) && typeof bay.bay === "string"
        ? `<div class="coach-bay-label">${bay.is_cabin ? "Cabin" : "Coupe"} ${escapeHtml(bay.bay)}</div>` : "";
      html += `${bayLabel}<div class="coach-bay-row ${isCabinOrCoupe ? "coach-bay-row--coupe" : ""}">
        <div class="coach-bay-block">${bay.left.map((s) => renderSeatBadge(s, null, occupiedSet)).join("")}</div>
        ${bay.right.length ? `<div class="coach-bay-block">${bay.right.map((s) => renderSeatBadge(s, null, occupiedSet)).join("")}</div>` : ""}
      </div>`;
      if (bay.side.length) {
        html += `<div class="coach-bay-side">${bay.side.map((s) => renderSeatBadge(s, "coach-seat--side", occupiedSet)).join("")}</div>`;
      }
    });
    html += `</div>`;
    return html;
  }

  function renderRowSeatMap(seatMap, occupiedSet) {
    const rows = seatMap.rows.slice(0, 10); // cap the diagram length; pattern repeats
    let html = `<div class="coach-diagram coach-diagram--row">
      <div class="coach-entry-row"><span>◄ Coach entry/exit</span><span>Coach entry/exit ►</span></div>`;
    rows.forEach((row) => {
      html += `<div class="coach-row">`;
      row.seats.forEach((s) => {
        const mapped = { window: "L", middle: "M", aisle: "U" }[s.type] || "M";
        html += renderSeatBadge({ number: s.number, type: mapped }, null, occupiedSet);
        if (s.aisle_after) html += `<div class="coach-aisle-gap"></div>`;
      });
      html += `</div>`;
    });
    html += `</div>`;
    return html;
  }

  document.getElementById("coachForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const travelClass = document.getElementById("coachClassSelect").value;
    const trainNumber = document.getElementById("coachTrainInput").value.trim();
    const coachSource = document.getElementById("coachSourceInput").value.trim();
    const coachDest = document.getElementById("coachDestInput").value.trim();
    const coachDate = document.getElementById("coachDateInput").value;
    const status = document.getElementById("coachStatus");
    const result = document.getElementById("coachResult");
    setStatus(status, "Loading…");
    result.hidden = true;
    try {
      const params = new URLSearchParams();
      if (trainNumber) params.set("train_number", trainNumber);
      if (coachSource) params.set("source", coachSource);
      if (coachDest) params.set("dest", coachDest);
      if (coachDate) params.set("date", toDDMMYYYY(coachDate));
      const qs = params.toString();
      const url = `/api/advanced/coach-layout/${encodeURIComponent(travelClass)}${qs ? `?${qs}` : ""}`;
      const res = await fetch(url);
      const data = await res.json();
      setStatus(status, "");
      result.hidden = false;
      if (!data.found) { result.innerHTML = `<p>No layout data for ${escapeHtml(travelClass)}.</p>`; return; }
      const L = data.layout;
      const M = data.seat_map;
      const occ = data.occupancy_estimate;
      const occupiedSet = occ && occ.occupied_berths ? new Set(occ.occupied_berths) : null;
      const heading = data.train_number
        ? `Train ${escapeHtml(data.train_number)}${data.train_name ? ` — ${escapeHtml(data.train_name)}` : ""} · ${escapeHtml(L.label)}`
        : escapeHtml(L.label);
      const diagram = M ? (M.kind === "bay" ? renderBaySeatMap(M, occupiedSet) : renderRowSeatMap(M, occupiedSet)) : "";
      const approxNote = M && M.approximate
        ? `<p class="tools-disclaimer">Numbering shown is a representative standard pattern for ${escapeHtml(travelClass)} (total ${M.total}) — real rakes vary more for this class than for SL/3A, so treat exact numbers as approximate.</p>`
        : "";
      const capacityNote = data.capacity_note ? `<p class="tools-disclaimer">${escapeHtml(data.capacity_note)}</p>` : "";
      const isRowBased = M && M.kind === "row";
      const legend = isRowBased
        ? `<span class="tools-badge coach-legend coach-legend--lower">Window</span>
           <span class="tools-badge coach-legend coach-legend--middle">Middle</span>
           <span class="tools-badge coach-legend coach-legend--upper">Aisle</span>`
        : `<span class="tools-badge coach-legend coach-legend--lower">Lower</span>
           <span class="tools-badge coach-legend coach-legend--middle">Middle</span>
           <span class="tools-badge coach-legend coach-legend--upper">Upper</span>`;
      // FEATURE: seat/berth occupancy estimate (crowd-position follow-up)
      // — shaded ✕ seats above come from occ.occupied_berths; this note
      // is the honest headline number + the disclaimer that it's a
      // distribution of the real aggregate count, not a live sensor.
      const occupancyNote = occ && occ.estimated_occupied != null
        ? `<p class="tools-badge is-no">✕ = likely occupied (estimate) — ~${occ.estimated_occupied} of ${occ.total} berths, based on real ${escapeHtml(occ.basis)} status "${escapeHtml(occ.source_status_text || "")}"</p>
           <p class="tools-disclaimer">${escapeHtml(occ.disclaimer)}</p>`
        : occ && occ.basis === "no_count"
          ? `<p class="tools-disclaimer">Couldn't get a live availability count for this train/route/date/class to estimate occupancy from — showing the plain layout instead.</p>`
          : (coachSource || coachDest || coachDate) && trainNumber
            ? `<p class="tools-disclaimer">Add a train number, From, To, AND date together to see an occupancy estimate.</p>`
            : "";
      result.innerHTML = `
        <h4>${heading} <span class="tools-badge">${M ? M.total : L.total_berths} berths/seats</span></h4>
        ${diagram}
        <p>
          ${legend}
          — pattern repeats along the coach; showing the first bays/rows.
        </p>
        ${occupancyNote}
        ${approxNote}
        ${capacityNote}
        ${data.train_lookup_error ? `<p class="tools-disclaimer">Couldn't look up train ${escapeHtml(data.train_number)}: ${escapeHtml(data.train_lookup_error)}</p>` : ""}
        ${data.occupancy_estimate_error ? `<p class="tools-disclaimer">Occupancy estimate unavailable: ${escapeHtml(data.occupancy_estimate_error)}</p>` : ""}
        <div class="tools-disclaimer">${escapeHtml(data.disclaimer)}</div>`;
    } catch { setStatus(status, "Couldn't reach the backend just now.", "is-error"); }
  });

  // -------------------------------------------------------------
  // FEATURE: Coach & Seat "Find My Coach" Guide
  // -------------------------------------------------------------
  document.getElementById("findCoachForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const trainNumber = document.getElementById("findCoachTrainInput").value.trim();
    const coachNumber = document.getElementById("findCoachNumberInput").value.trim();
    const status = document.getElementById("findCoachStatus");
    const result = document.getElementById("findCoachResult");
    setStatus(status, "Looking up…");
    result.hidden = true;
    try {
      const data = await postJSON("/api/advanced/find-my-coach", { coach_number: coachNumber, train_number: trainNumber || null });
      setStatus(status, "");
      result.hidden = false;
      if (!data.found) {
        result.innerHTML = `<p>${escapeHtml(data.note || "Couldn't parse that coach number.")}</p><div class="tools-disclaimer">${escapeHtml(data.disclaimer || "")}</div>`;
        return;
      }
      result.innerHTML = `
        <h4>Coach ${escapeHtml(data.coach_number)} <span class="tools-badge">${escapeHtml(data.class_block_position)}</span></h4>
        <p>Coach ${escapeHtml(String(data.coach_index_in_class))} of a typical ${data.typical_class_coach_count}-coach ${escapeHtml(data.travel_class || "")} block.</p>
        <ul>${data.platform_end_scenarios.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>
        <p><strong>Typical marshalling order (front to rear):</strong> ${data.typical_marshalling_order.map(escapeHtml).join(" → ")}</p>
        <p class="tools-disclaimer">${escapeHtml(data.recommendation)}</p>
        <div class="tools-disclaimer">${escapeHtml(data.disclaimer)}</div>`;
    } catch { setStatus(status, "Couldn't reach the backend just now.", "is-error"); }
  });

  // -------------------------------------------------------------
  // Seat Recommendation Engine
  // -------------------------------------------------------------
  document.getElementById("seatForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const travelClass = document.getElementById("seatClassSelect").value;
    const prefs = Array.from(document.querySelectorAll("#seatPrefGrid input:checked")).map((i) => i.value);
    const status = document.getElementById("seatStatus");
    const result = document.getElementById("seatResult");
    setStatus(status, "Thinking…");
    result.hidden = true;
    // FEATURE 2: trip-profile-based automatic berth/seat recommendation —
    // only sent when the rider actually filled in a departure or arrival
    // time, so a plain class+preferences lookup still behaves exactly as
    // before.
    const seatDep = document.getElementById("seatDepartureInput").value;
    const seatArr = document.getElementById("seatArrivalInput").value;
    const travelers = document.getElementById("seatTravelersSelect").value;
    const tripProfile = (seatDep || seatArr) ? { departure_time: seatDep || null, arrival_time: seatArr || null, travelers } : null;
    try {
      const data = await postJSON("/api/advanced/seat-recommend", { travel_class: travelClass, preferences: prefs, trip_profile: tripProfile });
      setStatus(status, "");
      result.hidden = false;
      const autoBlock = data.trip_profile_used ? `
        <div class="tools-result-card--prompt" style="margin:8px 0;padding:10px;border-radius:6px;">
          <strong>${data.recommended_berth_type ? `Recommended: ${escapeHtml(data.recommended_berth_type)} berth` : `Recommended: ${escapeHtml(data.recommended_seat_type)} seat`}</strong>
          ${data.duration_hours != null ? `<span class="result-tag"> · ${data.duration_hours}h${data.overnight ? " · overnight" : ""}</span>` : ""}
          <ul>${(data.recommendation_reasoning || []).map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>
        </div>` : "";
      result.innerHTML = `
        <h4>${escapeHtml(data.layout_label || travelClass)}</h4>
        ${autoBlock}
        ${data.advice.length ? `<ul>${data.advice.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul>` : (data.trip_profile_used ? "" : `<p>Pick a preference above for a tailored tip, or just note: ${escapeHtml(data.note)}</p>`)}
        <div class="tools-disclaimer">${escapeHtml(data.note)}</div>`;
    } catch { setStatus(status, "Couldn't reach the backend just now.", "is-error"); }
  });

  // -------------------------------------------------------------
  // Cross-Train Route Compare
  // -------------------------------------------------------------
  document.getElementById("compareForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const source = document.getElementById("compareSourceInput").value.trim().toUpperCase();
    const dest = document.getElementById("compareDestInput").value.trim().toUpperCase();
    const date = toDDMMYYYY(document.getElementById("compareDateInput").value);
    const travelClass = document.getElementById("compareClassSelect").value;
    const trainNumbers = document.getElementById("compareTrainsInput").value.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 4);
    const status = document.getElementById("compareStatus");
    const result = document.getElementById("compareResults");
    if (!trainNumbers.length) { setStatus(status, "Enter at least one train number.", "is-error"); return; }
    setStatus(status, "Fetching live fare & availability…");
    result.hidden = true;
    try {
      const data = await postJSON("/api/advanced/route-compare", { train_numbers: trainNumbers, source, dest, date, travel_class: travelClass });
      setStatus(status, `Comparing ${data.results.length} train(s) — ${escapeHtml(source)} → ${escapeHtml(dest)}, ${escapeHtml(date)}, ${escapeHtml(travelClass)}.`);
      result.hidden = false;
      result.innerHTML = data.results.map((r) => `
        <div class="compare-card">
          <h5>${escapeHtml(r.train_number)}${r.train_name ? ` — ${escapeHtml(r.train_name)}` : ""}</h5>
          <dl>
            <dt>Fare</dt><dd>${r.fare != null ? `₹${r.fare}` : (r.fare_error ? "unavailable" : "n/a")}</dd>
            <dt>Availability</dt><dd>${r.availability_status ? escapeHtml(r.availability_status) : (r.availability_error ? "unavailable" : "n/a")}</dd>
          </dl>
        </div>`).join("");
    } catch { setStatus(status, "Couldn't reach the backend just now.", "is-error"); }
  });

  // -------------------------------------------------------------
  // Cancellation Refund Estimator
  // -------------------------------------------------------------
  document.getElementById("refundForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fareAmount = parseFloat(document.getElementById("refundFareInput").value);
    const travelClass = document.getElementById("refundClassSelect").value;
    const ticketStatus = document.getElementById("refundStatusSelect").value;
    const hoursRaw = document.getElementById("refundHoursInput").value;
    const hours = hoursRaw === "" ? null : parseFloat(hoursRaw);
    const status = document.getElementById("refundStatus");
    const result = document.getElementById("refundResult");
    if (!Number.isFinite(fareAmount) || fareAmount <= 0) { setStatus(status, "Enter a valid fare amount.", "is-error"); return; }
    setStatus(status, "Calculating…");
    result.hidden = true;
    try {
      const data = await postJSON("/api/advanced/refund-estimate", {
        fare_amount: fareAmount, travel_class: travelClass, ticket_status: ticketStatus, hours_before_departure: hours,
      });
      setStatus(status, "");
      result.hidden = false;
      result.innerHTML = `
        <h4>Estimated refund: ₹${data.estimated_refund} <span class="tools-badge">deduction ₹${data.deduction}</span></h4>
        <ul>${data.breakdown.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>
        <div class="tools-disclaimer">${escapeHtml(data.disclaimer)}</div>`;
    } catch { setStatus(status, "Couldn't reach the backend just now.", "is-error"); }
  });

  // -------------------------------------------------------------
  // Fare & Availability Heatmap
  // -------------------------------------------------------------
  document.getElementById("heatmapForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const trainNumber = document.getElementById("heatmapTrainInput").value.trim();
    const source = document.getElementById("heatmapSourceInput").value.trim().toUpperCase();
    const dest = document.getElementById("heatmapDestInput").value.trim().toUpperCase();
    const startDate = toDDMMYYYY(document.getElementById("heatmapStartInput").value);
    const travelClass = document.getElementById("heatmapClassSelect").value;
    const days = parseInt(document.getElementById("heatmapDaysInput").value, 10) || 7;
    const status = document.getElementById("heatmapStatus");
    const result = document.getElementById("heatmapResults");
    if (!/^\d{5}$/.test(trainNumber) || !startDate) { setStatus(status, "Enter a valid train number and start date.", "is-error"); return; }
    setStatus(status, `Fetching ${Math.min(days, 10)} day(s) of live fare/availability — this may take a moment…`);
    result.hidden = true;
    try {
      const data = await postJSON("/api/advanced/fare-heatmap", { train_number: trainNumber, source, dest, start_date: startDate, days, travel_class: travelClass });
      if (data.error) { setStatus(status, data.error, "is-error"); return; }
      setStatus(status, `${data.cells.length} day(s) — ${escapeHtml(source)} → ${escapeHtml(dest)}, ${escapeHtml(travelClass)}.`);
      result.hidden = false;
      result.innerHTML = data.cells.map((c) => {
        const cls = c.status_text && /avail/i.test(c.status_text) ? "is-available" : (c.status_text && /wl|waitlist/i.test(c.status_text) ? "is-waitlist" : "");
        return `<div class="heatmap-cell ${cls}">
          <div class="heatmap-cell__date">${escapeHtml(c.date.slice(0, 5))}</div>
          <div class="heatmap-cell__weekday">${escapeHtml(c.weekday)}</div>
          <div class="heatmap-cell__fare">${c.fare != null ? `₹${c.fare}` : "—"}</div>
          <div class="heatmap-cell__status">${c.status_text ? escapeHtml(c.status_text) : (c.error ? "unavailable" : "n/a")}</div>
        </div>`;
      }).join("");
      // FEATURE: Fare & Availability "Alert Zone" — a real baseline fare
      // to watch from is only meaningful once a real heatmap has actually
      // loaded; the button stays disabled until then (see the intro text
      // in index.html for tool-heatmap).
      lastHeatmapContext = {
        trainNumber, source, dest, date: startDate, travelClass,
        baselineFare: data.cells.find((c) => c.fare != null)?.fare ?? null,
      };
      fareWatchAddBtn.disabled = lastHeatmapContext.baselineFare == null;
      setStatus(fareWatchStatus, lastHeatmapContext.baselineFare == null
        ? "No fare could be read from this heatmap to use as a baseline."
        : `Ready to watch ${escapeHtml(trainNumber)} ${escapeHtml(source)} → ${escapeHtml(dest)} (${escapeHtml(travelClass)}), baseline ₹${lastHeatmapContext.baselineFare}.`);
    } catch { setStatus(status, "Couldn't reach the backend just now.", "is-error"); }
  });

  // -------------------------------------------------------------
  // FEATURE: Fare & Availability "Alert Zone" — client-held watchlist
  // (same "localStorage + explicit push opt-in" pattern as Proactive
  // Delay Alerts just below), watching a route/class/date/quota rather
  // than a bare train number, with a real baseline fare captured from
  // the heatmap the watch was created from (see lastHeatmapContext above).
  // -------------------------------------------------------------
  const FARE_WATCH_KEY = "fareWatchList";
  function loadFareWatches() { try { return JSON.parse(localStorage.getItem(FARE_WATCH_KEY) || "[]"); } catch { return []; } }
  function saveFareWatches(list) {
    try { localStorage.setItem(FARE_WATCH_KEY, JSON.stringify(list)); } catch { /* unavailable */ }
    // Mirror to the backend for background push, same opt-in token as
    // Proactive Delay Alerts below ("pushDeviceToken" — shared across
    // both watch types, one browser = one push identity).
    const existingToken = localStorage.getItem("pushDeviceToken");
    if (existingToken) {
      postJSON("/api/push/fare-watches", {
        token: existingToken,
        watches: list.map((w) => ({
          train_number: w.trainNumber, source: w.source, dest: w.dest, date: w.date,
          travel_class: w.travelClass, quota: "GN", threshold_pct: w.thresholdPct,
          label: w.label, baseline_fare: w.baselineFare,
        })),
      }).catch(() => {});
    }
  }

  let lastHeatmapContext = null;
  const fareWatchAddBtn = document.getElementById("fareWatchAddBtn");
  const fareWatchStatus = document.getElementById("fareWatchStatus");
  const fareWatchList = document.getElementById("fareWatchList");

  async function renderFareWatches() {
    const list = loadFareWatches();
    fareWatchList.innerHTML = "";
    if (!list.length) { fareWatchList.innerHTML = `<li class="result-list--empty">No routes watched yet.</li>`; return; }
    let rowsByIndex = [];
    try {
      const data = await postJSON("/api/advanced/fare-watch/check", {
        watches: list.map((w) => ({
          train_number: w.trainNumber, source: w.source, dest: w.dest, date: w.date,
          travel_class: w.travelClass, quota: "GN", threshold_pct: w.thresholdPct,
          label: w.label, baseline_fare: w.baselineFare,
        })),
      });
      rowsByIndex = data.watches || [];
    } catch { /* rows below just show "checking" state */ }
    list.forEach((w, idx) => {
      const row = rowsByIndex[idx] || {};
      const li = document.createElement("li");
      let badge = `<span class="result-tag">checking…</span>`;
      if (row.fare != null || row.status_text) {
        const dropText = row.fare_drop_pct != null && row.fare_drop_pct > 0 ? ` (-${row.fare_drop_pct}%)` : "";
        badge = `<span class="tools-badge ${row.breached ? "is-yes" : ""}">${row.fare != null ? `₹${row.fare}${dropText}` : ""}${row.status_text ? ` · ${escapeHtml(row.status_text)}` : ""}</span>`;
      }
      li.innerHTML = `<span><strong>${escapeHtml(w.trainNumber)}</strong>${w.label ? ` — ${escapeHtml(w.label)}` : ""} ${escapeHtml(w.source)}→${escapeHtml(w.dest)} (${escapeHtml(w.travelClass)}) <span>baseline ₹${w.baselineFare}, alert ≥${w.thresholdPct}% drop</span></span>${badge}`;
      const rmBtn = document.createElement("button");
      rmBtn.className = "remove-btn"; rmBtn.type = "button"; rmBtn.setAttribute("aria-label", "Remove"); rmBtn.textContent = "×";
      rmBtn.addEventListener("click", () => { const u = loadFareWatches(); u.splice(idx, 1); saveFareWatches(u); renderFareWatches(); });
      li.appendChild(rmBtn);
      fareWatchList.appendChild(li);
    });
  }

  document.getElementById("fareWatchAddForm").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!lastHeatmapContext) { setStatus(fareWatchStatus, "Build a heatmap above first.", "is-error"); return; }
    const thresholdPct = parseInt(document.getElementById("fareWatchThresholdInput").value, 10) || 10;
    const label = document.getElementById("fareWatchLabelInput").value.trim();
    const list = loadFareWatches();
    list.push({ ...lastHeatmapContext, thresholdPct, label });
    saveFareWatches(list);
    document.getElementById("fareWatchLabelInput").value = "";
    setStatus(fareWatchStatus, "Watching this route.");
    renderFareWatches();
  });
  document.querySelector('.tools-tab[data-tool="heatmap"]').addEventListener("click", renderFareWatches);

  // -------------------------------------------------------------
  // Proactive Delay Alerts (watchlist kept in localStorage, checked
  // live via a batch endpoint — see the tab's own intro text re: no
  // background push notifications)
  // -------------------------------------------------------------
  const ALERTS_KEY = "delayAlertWatches";
  function loadAlerts() { try { return JSON.parse(localStorage.getItem(ALERTS_KEY) || "[]"); } catch { return []; } }
  function saveAlerts(list) { try { localStorage.setItem(ALERTS_KEY, JSON.stringify(list)); } catch { /* unavailable */ } }

  const alertsList = document.getElementById("alertsList");
  const alertsStatus = document.getElementById("alertsStatus");

  async function renderAlerts() {
    const list = loadAlerts();
    alertsList.innerHTML = "";
    if (!list.length) { alertsList.innerHTML = `<li class="result-list--empty">No watches yet — add a train above.</li>`; return; }
    setStatus(alertsStatus, "Checking live delay…");
    // Matched to `list` by ARRAY POSITION, not by train_number — the
    // backend returns one prediction row per watch in the same order the
    // watches were sent, and two watches CAN share a train number
    // (different date and/or label). Keying by train_number alone let the
    // second watch's result silently overwrite the first's, so both rows
    // displayed whichever prediction loaded last instead of their own.
    let rowsByIndex = [];
    try {
      const data = await postJSON("/api/advanced/alerts/check", {
        watches: list.map((w) => ({ train_number: w.trainNumber, date: w.date ? toDDMMYYYY(w.date) : null, threshold_minutes: w.threshold, label: w.label })),
      });
      rowsByIndex = data.watches || [];
      setStatus(alertsStatus, data.note || "");
    } catch { setStatus(alertsStatus, "Couldn't refresh alerts just now.", "is-error"); }
    list.forEach((w, idx) => {
      const row = rowsByIndex[idx] || {};
      const li = document.createElement("li");
      // FEATURE: label-aware station status — the watch's label is now
      // checked against the train's real live route (see backend
      // _predict_for_watch_station). Three real outcomes beyond the old
      // plain delay badge, plus the old badge unchanged for "predicted".
      let badge;
      if (row.error) {
        badge = `<span class="result-tag">check failed</span>`;
      } else if (row.station_status === "not_on_route") {
        badge = `<span class="result-tag" title="${escapeHtml(row.message || "")}">station not on route</span>`;
      } else if (row.station_status === "already_reached") {
        badge = `<span class="tools-badge is-yes">already at ${escapeHtml(row.already_reached_at || "—")}</span>`;
      } else if (row.predicted_delay_minutes == null) {
        badge = `<span class="result-tag">no prediction yet</span>`;
      } else {
        badge = `<span class="tools-badge ${row.breached ? "is-no" : "is-yes"}">${row.breached ? "⚠ " : ""}+${formatDelayDuration(row.predicted_delay_minutes)}${row.breached ? " ≥ threshold" : ""}</span>`;
      }
      const stationName = row.station ? ` <span class="result-tag">${escapeHtml(row.station)}</span>` : "";
      li.innerHTML = `<span><strong>${escapeHtml(w.trainNumber)}</strong>${w.label ? ` — ${escapeHtml(w.label)}` : ""}${stationName} <span>(alert ≥ ${w.threshold}m)</span></span>${badge}`;
      const rmBtn = document.createElement("button");
      rmBtn.className = "remove-btn"; rmBtn.type = "button"; rmBtn.setAttribute("aria-label", "Remove"); rmBtn.textContent = "×";
      rmBtn.addEventListener("click", () => { const u = loadAlerts(); u.splice(idx, 1); saveAlerts(u); renderAlerts(); });
      li.appendChild(rmBtn);
      alertsList.appendChild(li);
    });
  }

  document.getElementById("alertAddForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const trainNumber = document.getElementById("alertTrainInput").value.trim();
    if (!/^\d{5}$/.test(trainNumber)) { setStatus(alertsStatus, "Enter a valid 5-digit train number.", "is-error"); return; }
    const date = document.getElementById("alertDateInput").value;
    const label = document.getElementById("alertLabelInput").value.trim();
    const threshold = parseInt(document.getElementById("alertThresholdInput").value, 10) || 15;
    const list = loadAlerts();
    list.push({ trainNumber, date, label, threshold });
    saveAlerts(list);
    document.getElementById("alertAddForm").reset();
    document.getElementById("alertThresholdInput").value = 15;
    renderAlerts();
  });
  document.querySelector('.tools-tab[data-tool="alerts"]').addEventListener("click", renderAlerts);

  // -------------------------------------------------------------
  // Push Notifications for Proactive Alerts
  // -----------------------------------------------------------------
  // Registers this browser with Firebase Cloud Messaging, then mirrors
  // the SAME watchlist already held in localStorage (ALERTS_KEY above)
  // up to the backend's push_store.py so the background scheduler can
  // see it while the tab is closed. The in-tab checking above keeps
  // working exactly as before either way — this only adds background
  // delivery on top of it.
  //
  // SETUP: fill in FIREBASE_CONFIG + FIREBASE_VAPID_KEY below from your
  // own Firebase project (Console -> Project Settings -> General for the
  // config object, -> Cloud Messaging -> Web Push certificates for the
  // VAPID key). Same config object also goes in firebase-messaging-sw.js.
  // Until filled in, the Enable button shows a clear "not configured"
  // message instead of failing silently.
  // -------------------------------------------------------------
  const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBTSGSVdsnZ0bqOwbdxrt2genJQtadRx5M",
  authDomain: "railway-142a6.firebaseapp.com",
  projectId: "railway-142a6",
  storageBucket: "railway-142a6.firebasestorage.app",
  messagingSenderId: "72786651974",
  appId: "1:72786651974:web:67e9a8337aba65c86e9347",
  measurementId: "G-PQB5J6ET1M"
};
  const FIREBASE_VAPID_KEY = "BMu0pxEE23rJpmRM9zYTFN9VxHx5Qeo36SFA51_n70NjdSmA9aFe6814lT_aL80FJKqwh2U2miiCPwjJi4zNxys";
  const PUSH_TOKEN_KEY = "pushDeviceToken";
  const pushEnableBtn = document.getElementById("pushEnableBtn");
  const pushEnableStatus = document.getElementById("pushEnableStatus");

  function isFirebaseConfigured() {
    return FIREBASE_CONFIG.apiKey && !FIREBASE_CONFIG.apiKey.startsWith("YOUR_")
      && FIREBASE_VAPID_KEY && !FIREBASE_VAPID_KEY.startsWith("YOUR_");
  }

  async function syncWatchesToServer(token) {
    const list = loadAlerts();
    await postJSON("/api/push/watches", {
      token,
      watches: list.map((w) => ({
        train_number: w.trainNumber,
        date: w.date ? toDDMMYYYY(w.date) : null,
        threshold_minutes: w.threshold,
        label: w.label,
      })),
    });
  }

  async function enablePushNotifications() {
    if (!isFirebaseConfigured()) {
      setStatus(pushEnableStatus, "Push isn't set up yet — add your Firebase project config in app.js (see comments above enablePushNotifications).", "is-error");
      return;
    }
    if (!loadAlerts().length) {
      setStatus(pushEnableStatus, "Add at least one watch above first.", "is-error");
      return;
    }
    try {
      setStatus(pushEnableStatus, "Requesting notification permission…");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus(pushEnableStatus, "Notification permission was not granted.", "is-error");
        return;
      }
      if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
      const messaging = firebase.messaging();
      // Foreground handler: when THIS tab is the focused/visible one, Firebase
      // routes an incoming push to the page instead of letting the service
      // worker auto-display it (that only happens when the tab is backgrounded
      // or closed — see firebase-messaging-sw.js's onBackgroundMessage). Without
      // this, a push that arrives while you're looking at the app produces no
      // visible notification at all, even though delivery succeeded.
      messaging.onMessage((payload) => {
        console.log("[push] onMessage fired (foreground):", payload);
        const title = payload.notification?.title || "Train delay alert";
        const body = payload.notification?.body || "";
        if (Notification.permission === "granted") {
          try {
            new Notification(title, { body, icon: "/assets/icons/train-marker.png" });
            console.log("[push] Notification() call succeeded.");
          } catch (notifErr) {
            console.error("[push] Notification() call threw:", notifErr);
          }
        } else {
          console.warn("[push] onMessage fired but permission is:", Notification.permission);
        }
      });
      console.log("[push] onMessage handler attached.");
      const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
      // register() resolves as soon as registration is ACCEPTED, not once the
      // worker is ACTIVE — calling getToken() immediately after can race the
      // worker's install/activate steps and fail with "no active Service
      // Worker". navigator.serviceWorker.ready waits until there's an active
      // worker for this scope before resolving, closing that race.
      await navigator.serviceWorker.ready;
      try {
        // Force out any stale cached token first. getToken() alone can hand
        // back a cached token bound to a Push subscription that no longer
        // actually exists (this is exactly what happened during testing —
        // even a full "Clear site data" didn't always tear down the
        // underlying browser Push subscription). deleteToken() explicitly
        // unsubscribes it, so the getToken() call right after this is
        // guaranteed to mint a genuinely new one instead of reusing a dead one.
        await messaging.deleteToken();
      } catch (_) {
        // No existing token to delete — fine, proceed to request a fresh one.
      }
      const token = await messaging.getToken({ vapidKey: FIREBASE_VAPID_KEY, serviceWorkerRegistration: registration });
      if (!token) {
        setStatus(pushEnableStatus, "Couldn't get a push token from this browser.", "is-error");
        return;
      }
      localStorage.setItem(PUSH_TOKEN_KEY, token);
      await postJSON("/api/push/register-token", { token, platform: "web" });
      await syncWatchesToServer(token);
      setStatus(pushEnableStatus, "✅ Push notifications enabled for your current watches.");
    } catch (err) {
      setStatus(pushEnableStatus, `Couldn't enable push notifications: ${err && err.message ? err.message : err}`, "is-error");
    }
  }

  // FEATURE: Background-surviving Smart Alarm — shared token-acquisition
  // helper, exposed on `window` because this app.js file is actually TWO
  // separate top-level IIFEs (this Firebase/push block lives in the
  // second one; the Live Tracking / Smart Alarm code that needs to call
  // this lives in the FIRST one, so a plain top-of-file const/function
  // wouldn't be visible there — see the ddmmyyyy/toDDMMYYYY cross-IIFE bug
  // fixed in an earlier round for the exact same reason). Reuses the same
  // permission -> init -> register service worker -> deleteToken -> getToken
  // -> register-with-backend sequence as enablePushNotifications above,
  // just without requiring an existing Delay Alerts watchlist and without
  // touching PUSH_TOKEN_KEY's "push enabled" UI state (a Smart Alarm
  // background-push registration is independent of that toggle).
  window.getOrCreateWebPushToken = async function () {
    if (!isFirebaseConfigured()) throw new Error("Push isn't set up on this server yet.");
    if (!("Notification" in window) || !("serviceWorker" in navigator)) throw new Error("This browser doesn't support push notifications.");
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Notification permission was not granted.");
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    const messaging = firebase.messaging();
    const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
    await navigator.serviceWorker.ready;
    try { await messaging.deleteToken(); } catch (_) { /* nothing cached to delete — fine */ }
    const token = await messaging.getToken({ vapidKey: FIREBASE_VAPID_KEY, serviceWorkerRegistration: registration });
    if (!token) return null;
    localStorage.setItem(PUSH_TOKEN_KEY, token);
    await postJSON("/api/push/register-token", { token, platform: "web" });
    return token;
  };

  if (pushEnableBtn) {
    pushEnableBtn.addEventListener("click", enablePushNotifications);
    if (!("Notification" in window) || !("serviceWorker" in navigator)) {
      pushEnableBtn.disabled = true;
      setStatus(pushEnableStatus, "This browser doesn't support push notifications.", "is-error");
    } else if (localStorage.getItem(PUSH_TOKEN_KEY) && isFirebaseConfigured() && Notification.permission === "granted") {
      // Push was already enabled in an earlier session — re-attach the
      // foreground onMessage handler now so a page reload doesn't silently
      // lose it until the button is clicked again.
      try {
        if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
        firebase.messaging().onMessage((payload) => {
          console.log("[push] onMessage fired (foreground, reload-reattached):", payload);
          const title = payload.notification?.title || "Train delay alert";
          const body = payload.notification?.body || "";
          try {
            new Notification(title, { body, icon: "/assets/icons/train-marker.png" });
            console.log("[push] Notification() call succeeded.");
          } catch (notifErr) {
            console.error("[push] Notification() call threw:", notifErr);
          }
        });
        console.log("[push] onMessage handler re-attached on page load.");
        setStatus(pushEnableStatus, "Push notifications enabled for your current watches.");
      } catch (err) {
        console.error("[push] Failed to re-attach onMessage on page load:", err);
        // Non-fatal — background delivery via the service worker still works
        // even if this re-attach fails; only foreground display is affected.
      }
    }
  }

  // Keep the server-side watchlist mirror in sync whenever a watch is
  // added/removed, but only if push was already enabled on this device
  // (no point registering silently — the button above is the explicit
  // opt-in). Wrapped around the existing save points rather than adding
  // a new listener, so this never runs out of sync with what's on screen.
  const _origSaveAlerts = saveAlerts;
  saveAlerts = function (list) {
    _origSaveAlerts(list);
    const existingToken = localStorage.getItem(PUSH_TOKEN_KEY);
    if (existingToken) syncWatchesToServer(existingToken).catch(() => {});
  };

  // -------------------------------------------------------------
  // Live Station Crowd Estimation
  // -------------------------------------------------------------
  document.getElementById("stationCrowdForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const station = document.getElementById("stationCrowdInput").value.trim().toUpperCase();
    const hours = document.getElementById("stationCrowdHours").value;
    const status = document.getElementById("stationCrowdStatus");
    const result = document.getElementById("stationCrowdResult");
    if (!station) return;
    setStatus(status, "Estimating…");
    result.hidden = true;
    try {
      const res = await fetch(`/api/advanced/station-crowd/${encodeURIComponent(station)}?hours=${hours}`);
      const data = await res.json();
      setStatus(status, "");
      result.hidden = false;
      if (data.error) { result.innerHTML = `<p>${escapeHtml(data.error)}</p>`; return; }
      const filled = data.level;
      let bars = "";
      for (let i = 1; i <= 4; i++) bars += `<div class="crowd-meter__bar ${i <= filled ? "is-filled" : ""} ${filled >= 4 ? "is-high" : ""}"></div>`;
      result.innerHTML = `
        <h4>${escapeHtml(station)} <span class="tools-badge">${escapeHtml(data.label)}</span></h4>
        <div class="crowd-meter">${bars}</div>
        <p>${data.trains_in_window} train(s) due in the next ${data.hours_window}h${data.is_rush_hour ? " · rush hour" : ""}.</p>
        <div class="tools-disclaimer">${escapeHtml(data.disclaimer)}</div>`;
    } catch { setStatus(status, "Couldn't reach the backend just now.", "is-error"); }
  });

  // -------------------------------------------------------------
  // Smart Luggage/Parcel Tracking (informational — see backend note)
  // -------------------------------------------------------------
  async function loadParcelInfo() {
    const status = document.getElementById("parcelStatus");
    const result = document.getElementById("parcelResult");
    setStatus(status, "Loading…");
    result.hidden = true;
    try {
      const res = await fetch("/api/advanced/parcel-info");
      const data = await res.json();
      setStatus(status, "");
      result.hidden = false;
      result.innerHTML = `
        <h4>Parcel/luggage tracking isn't available here</h4>
        <p>${escapeHtml(data.reason)}</p>
        <p>${escapeHtml(data.what_you_can_track_there)}</p>
        <p><a href="${data.official_portal_url}" target="_blank" rel="noopener">${escapeHtml(data.official_portal_label)} ↗</a></p>`;
    } catch { setStatus(status, "Couldn't reach the backend just now.", "is-error"); }
  }
  document.querySelector('.tools-tab[data-tool="parcel"]').addEventListener("click", loadParcelInfo);

  // -------------------------------------------------------------
  // Offline Route Maps & Station Information
  // -------------------------------------------------------------
  const OFFLINE_KEY = "offlineStationBundle";
  const TILE_CACHE_NAME = "offline-map-tiles-v1";
  const TILE_ZOOM = 14; // one modest zoom level — a small local area, not a full route map
  let offlineMap = null;
  let offlineMapLayer = null;
  let currentStationEntry = null;

  document.getElementById("offlineDownloadForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const status = document.getElementById("offlineStatus");
    setStatus(status, "Downloading…");
    try {
      const res = await fetch("/api/advanced/offline-stations");
      const data = await res.json();
      localStorage.setItem(OFFLINE_KEY, JSON.stringify({ stations: data.stations, savedAt: new Date().toISOString() }));
      setStatus(status, `Saved ${Object.keys(data.stations).length} stations for offline use. (This saves the station list/amenities only — use "Download map tiles" below, per station, for an actual offline map.)`);
    } catch { setStatus(status, "Couldn't download just now — check your connection.", "is-error"); }
  });

  // Tile x/y for a given lat/lng/zoom (standard Web Mercator slippy-map formula)
  function latLngToTile(lat, lng, zoom) {
    const n = Math.pow(2, zoom);
    const x = Math.floor(((lng + 180) / 360) * n);
    const latRad = (lat * Math.PI) / 180;
    const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
    return { x, y };
  }

  async function downloadTilesForStation(lat, lng, statusEl) {
    if (!("caches" in window)) {
      setStatus(statusEl, "This browser doesn't support offline tile caching (Cache Storage API unavailable).", "is-error");
      return;
    }
    const { x: cx, y: cy } = latLngToTile(lat, lng, TILE_ZOOM);
    const subdomains = ["a", "b", "c"];
    const tiles = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const x = cx + dx, y = cy + dy;
        const s = subdomains[Math.abs(x + y) % subdomains.length];
        tiles.push(`https://${s}.tile.openstreetmap.org/${TILE_ZOOM}/${x}/${y}.png`);
      }
    }
    const cache = await caches.open(TILE_CACHE_NAME);
    let done = 0;
    setStatus(statusEl, `Downloading map tiles… 0/${tiles.length}`);
    for (const url of tiles) {
      try {
        const already = await cache.match(url);
        if (!already) {
          const resp = await fetch(url, { mode: "cors" });
          if (resp.ok) await cache.put(url, resp.clone());
        }
      } catch { /* one tile failing shouldn't stop the rest */ }
      done++;
      setStatus(statusEl, `Downloading map tiles… ${done}/${tiles.length}`);
      await new Promise((r) => setTimeout(r, 150)); // be considerate to the public OSM tile server
    }
    setStatus(statusEl, `Saved ${tiles.length} map tiles around this station for offline use (zoom ${TILE_ZOOM}).`);
  }

  // A tile layer that serves from the Cache Storage entry saved above when
  // present, and otherwise falls back to the normal live network request
  // (so the map still works online for stations you haven't downloaded).
  const CacheAwareTileLayer = L.TileLayer.extend({
    createTile(coords, done) {
      const img = document.createElement("img");
      const url = this.getTileUrl(coords);
      if ("caches" in window) {
        caches.open(TILE_CACHE_NAME).then((cache) =>
          cache.match(url).then((cached) => {
            if (cached) {
              cached.blob().then((blob) => { img.src = URL.createObjectURL(blob); done(null, img); });
            } else {
              img.onload = () => done(null, img);
              img.onerror = (err) => done(err, img);
              img.src = url;
            }
          })
        );
      } else {
        img.onload = () => done(null, img);
        img.onerror = (err) => done(err, img);
        img.src = url;
      }
      return img;
    },
  });

  function showStationMap(entry) {
    const container = document.getElementById("offlineMapContainer");
    container.hidden = false;
    if (!offlineMap) {
      offlineMap = L.map(container).setView([entry.lat, entry.lng], TILE_ZOOM);
      offlineMapLayer = new CacheAwareTileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors", maxZoom: 18,
      }).addTo(offlineMap);
    } else {
      offlineMap.setView([entry.lat, entry.lng], TILE_ZOOM);
      setTimeout(() => offlineMap.invalidateSize(), 50);
    }
    if (offlineMap._stationMarker) offlineMap.removeLayer(offlineMap._stationMarker);
    offlineMap._stationMarker = L.marker([entry.lat, entry.lng]).addTo(offlineMap).bindPopup(entry.name);
  }

  document.getElementById("offlineLookupForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const code = document.getElementById("offlineLookupInput").value.trim().toUpperCase();
    const result = document.getElementById("offlineResult");
    const status = document.getElementById("offlineStatus");
    const mapActions = document.getElementById("offlineMapActions");
    let bundle;
    try { bundle = JSON.parse(localStorage.getItem(OFFLINE_KEY) || "null"); } catch { bundle = null; }
    if (!bundle) { setStatus(status, "No offline data saved yet — press Download first (needs network once).", "is-error"); result.hidden = true; mapActions.hidden = true; return; }
    const entry = bundle.stations[code];
    result.hidden = false;
    if (!entry) {
      result.innerHTML = `<p>${escapeHtml(code)} isn't in the saved offline set.</p>`;
      mapActions.hidden = true;
      document.getElementById("offlineMapContainer").hidden = true;
      return;
    }
    result.innerHTML = `
      <h4>${escapeHtml(entry.name)} (${escapeHtml(code)})</h4>
      <p>Coordinates: ${entry.lat}, ${entry.lng}</p>
      ${entry.amenities ? `<div class="tools-badges">${["food_court", "executive_lounge", "retiring_room", "wifi", "cloak_room", "waiting_room"].map((k) => `<span class="tools-badge ${entry.amenities[k] ? "is-yes" : "is-no"}">${entry.amenities[k] ? "✓" : "✕"} ${k.replace("_", " ")}</span>`).join("")}</div>` : "<p>No amenity data cached for this station.</p>"}
      <p class="tools-disclaimer">Saved offline on ${escapeHtml(new Date(bundle.savedAt).toLocaleString())}.</p>`;

    currentStationEntry = entry;
    mapActions.hidden = false;
    setStatus(document.getElementById("offlineMapStatus"), "");
    showStationMap(entry);
  });

  document.getElementById("offlineMapDownloadBtn").addEventListener("click", async () => {
    if (!currentStationEntry) return;
    const btn = document.getElementById("offlineMapDownloadBtn");
    const statusEl = document.getElementById("offlineMapStatus");
    btn.disabled = true;
    await downloadTilesForStation(currentStationEntry.lat, currentStationEntry.lng, statusEl);
    btn.disabled = false;
  });

  // -------------------------------------------------------------
  // Interactive Journey Timeline (Gantt view)
  // -------------------------------------------------------------
  document.getElementById("ganttForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const trainNumber = document.getElementById("ganttTrainInput").value.trim();
    const date = toDDMMYYYY(document.getElementById("ganttDateInput").value);
    const status = document.getElementById("ganttStatus");
    const result = document.getElementById("ganttResult");
    if (!/^\d{5}$/.test(trainNumber)) { setStatus(status, "Enter a valid 5-digit train number.", "is-error"); return; }
    setStatus(status, "Loading timeline…");
    result.hidden = true;
    try {
      const url = `/api/advanced/journey-timeline/${encodeURIComponent(trainNumber)}` + (date ? `?date=${encodeURIComponent(date)}` : "");
      const res = await fetch(url);
      const data = await res.json();
      if (data.error) { setStatus(status, data.error, "is-error"); return; }
      const stops = (data.stops || []).filter((s) => s.kind === "stoppage");
      if (!stops.length) { setStatus(status, "No stop data available.", "is-error"); return; }
      setStatus(status, `${stops.length} stop(s).`);
      result.hidden = false;
      const total = stops.length;
      result.innerHTML = stops.map((s, i) => {
        const pct = Math.round((i / Math.max(total - 1, 1)) * 100);
        const barClass = s.status === "passed" ? "" : s.status === "current" ? "is-current" : "is-upcoming";
        const delay = s.arrival?.delay_minutes ?? s.departure?.delay_minutes;
        const delayText = delay != null ? `+${formatDelayDuration(delay)}` : "on time / n.a.";
        return `<div class="gantt-row">
          <div class="gantt-row__name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</div>
          <div class="gantt-row__bar-track"><div class="gantt-row__bar ${barClass}" style="width:${Math.max(pct, 4)}%"></div></div>
          <div class="gantt-row__delay ${delay > 10 ? "is-late" : ""}">${escapeHtml(delayText)}</div>
        </div>`;
      }).join("") + `<div class="gantt-legend"><span class="is-passed">Passed</span><span class="is-current">Current</span><span class="is-upcoming">Upcoming</span></div>`;
    } catch { setStatus(status, "Couldn't reach the backend just now.", "is-error"); }
  });

  // -------------------------------------------------------------
  // Personalized Travel Assistant (Profile & History)
  // -------------------------------------------------------------
  const PROFILE_KEY = "travelProfileHistory";
  function loadProfileHistory() { try { return JSON.parse(localStorage.getItem(PROFILE_KEY) || "[]"); } catch { return []; } }
  function saveProfileHistory(list) { try { localStorage.setItem(PROFILE_KEY, JSON.stringify(list)); } catch { /* unavailable */ } }

  async function renderProfile() {
    const list = loadProfileHistory();
    const status = document.getElementById("profileStatus");
    const summaryEl = document.getElementById("profileSummary");
    const tripListEl = document.getElementById("profileTripList");

    tripListEl.innerHTML = "";
    list.forEach((t, idx) => {
      const li = document.createElement("li");
      li.innerHTML = `<span>${escapeHtml(t.source)} → ${escapeHtml(t.dest)} <span class="result-tag">${escapeHtml(t.travel_class)}</span> <span>(${escapeHtml(toDDMMYYYY(t.date))})</span></span>`;
      const rmBtn = document.createElement("button");
      rmBtn.className = "remove-btn"; rmBtn.type = "button"; rmBtn.setAttribute("aria-label", "Remove"); rmBtn.textContent = "×";
      rmBtn.addEventListener("click", () => { const u = loadProfileHistory(); u.splice(idx, 1); saveProfileHistory(u); renderProfile(); });
      li.appendChild(rmBtn);
      tripListEl.appendChild(li);
    });

    if (!list.length) {
      summaryEl.hidden = true;
      setStatus(status, "Log a few trips to build your profile.");
      return;
    }
    setStatus(status, "Summarizing…");
    try {
      const data = await postJSON("/api/advanced/profile/summary", {
        history: list.map((t) => ({ source: t.source, dest: t.dest, travel_class: t.travel_class, date: toDDMMYYYY(t.date) })),
      });
      setStatus(status, "");
      summaryEl.hidden = false;
      const r = data.frequent_route;
      const reminder = data.booking_reminder;
      summaryEl.innerHTML = `
        <h4>Your travel profile <span class="tools-badge">${data.trip_count} trip(s) logged</span></h4>
        ${r ? `<p>Frequent route: <strong>${escapeHtml(r.source)} → ${escapeHtml(r.dest)}</strong> (${r.count}×)</p>` : ""}
        <p>Preferred class: <strong>${escapeHtml(data.preferred_class || "n/a")}</strong> · Home station: <strong>${escapeHtml(data.home_station || "n/a")}</strong></p>
        ${reminder ? `<div class="tools-badges"><span class="tools-badge is-yes">🔔 You often travel ${escapeHtml(reminder.route || "")} on ${escapeHtml(reminder.weekday)}s — next one is ${escapeHtml(reminder.next_date)} (${reminder.days_away} day(s) away). Consider booking in ${escapeHtml(reminder.preferred_class || "your usual class")}.</span></div>` : ""}`;
    } catch { setStatus(status, "Couldn't reach the backend just now.", "is-error"); }
  }

  document.getElementById("profileAddForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const source = document.getElementById("profileSourceInput").value.trim().toUpperCase();
    const dest = document.getElementById("profileDestInput").value.trim().toUpperCase();
    const travel_class = document.getElementById("profileClassSelect").value;
    const date = document.getElementById("profileDateInput").value;
    if (!source || !dest || !date) return;
    const list = loadProfileHistory();
    list.push({ source, dest, travel_class, date });
    saveProfileHistory(list);
    document.getElementById("profileAddForm").reset();
    renderProfile();
  });
  document.querySelector('.tools-tab[data-tool="profile"]').addEventListener("click", renderProfile);

  document.getElementById("packedForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const trainNumber = document.getElementById("packedTrainInput").value.trim();
    const date = toDDMMYYYY(document.getElementById("packedDateInput").value);
    const status = document.getElementById("packedStatus");
    const result = document.getElementById("packedResult");
    if (!/^\d{5}$/.test(trainNumber) || !date) { setStatus(status, "Enter a valid train number and date.", "is-error"); return; }
    const history = loadProfileHistory();
    const route = history[history.length - 1];
    if (!route) { setStatus(status, "Log at least one trip above first, so I know the route/class to check.", "is-error"); return; }
    setStatus(status, "Checking live crowd…");
    result.hidden = true;
    try {
      const data = await postJSON("/api/advanced/profile/packed-check", {
        train_number: trainNumber, source: route.source, dest: route.dest, date, travel_class: route.travel_class,
      });
      setStatus(status, "");
      result.hidden = false;
      const y = data.your_train;
      result.innerHTML = `
        <h4>Train ${escapeHtml(trainNumber)} — <span class="tools-badge ${y.level === "High" || y.level === "Very High" ? "is-no" : "is-yes"}">${escapeHtml(y.level)}</span></h4>
        ${y.seat_data_error ? `<p class="tools-disclaimer">Live seat data unavailable: ${escapeHtml(y.seat_data_error)}</p>` : ""}
        ${data.alternatives.length ? `<h5>Alternatives (${escapeHtml(route.source)} → ${escapeHtml(route.dest)})</h5>` + data.alternatives.map((a) => `<p>Train ${escapeHtml(a.train_number)} — <span class="tools-badge">${escapeHtml(a.level)}</span></p>`).join("") : ""}
        <p class="tools-disclaimer">${escapeHtml(data.note)}</p>`;
    } catch { setStatus(status, "Couldn't reach the backend just now.", "is-error"); }
  });

  document.getElementById("altPlanForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const trainNumber = document.getElementById("altPlanTrainInput").value.trim();
    const date = toDDMMYYYY(document.getElementById("altPlanDateInput").value);
    const threshold = parseInt(document.getElementById("altPlanThresholdInput").value, 10) || 20;
    const status = document.getElementById("altPlanStatus");
    const result = document.getElementById("altPlanResult");
    if (!/^\d{5}$/.test(trainNumber) || !date) { setStatus(status, "Enter a valid train number and date.", "is-error"); return; }
    const history = loadProfileHistory();
    const route = history[history.length - 1];
    if (!route) { setStatus(status, "Log at least one trip above first, so I know the route/class to check.", "is-error"); return; }
    setStatus(status, "Checking predicted delay…");
    result.hidden = true;
    try {
      const data = await postJSON("/api/advanced/profile/alternative-plan", {
        train_number: trainNumber, source: route.source, dest: route.dest, date,
        travel_class: route.travel_class, delay_threshold_minutes: threshold,
      });
      setStatus(status, "");
      result.hidden = false;
      result.innerHTML = `
        <h4>${data.delayed_beyond_threshold ? "⚠ Alternative suggested" : "✓ No alternative needed"} <span class="tools-badge">${data.predicted_delay_minutes != null ? `+${formatDelayDuration(data.predicted_delay_minutes)} predicted` : "no prediction"}</span></h4>
        ${(data.alternatives || []).map((a) => `<p>Train ${escapeHtml(a.train_number)}${a.train_name ? ` — ${escapeHtml(a.train_name)}` : ""}${a.departure ? ` (dep ${escapeHtml(a.departure)})` : ""} — crowd <span class="tools-badge">${escapeHtml(a.level)}</span> · ${a.availability_status ? escapeHtml(a.availability_status) : "availability unavailable"}</p>`).join("")}
        <p class="tools-disclaimer">${escapeHtml(data.note)}</p>`;
    } catch { setStatus(status, "Couldn't reach the backend just now.", "is-error"); }
  });

  // -------------------------------------------------------------
  // "Near Me" Real-Time Platform Information
  // -------------------------------------------------------------
  document.getElementById("nearMeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const station = document.getElementById("nearMeStationInput").value.trim().toUpperCase();
    const hours = document.getElementById("nearMeHours").value;
    const status = document.getElementById("nearMeStatus");
    const nextArrivalEl = document.getElementById("nearMeNextArrival");
    const heatmapEl = document.getElementById("nearMeHeatmap");
    const listEl = document.getElementById("nearMeTrainList");
    if (!station) return;
    setStatus(status, "Loading…");
    nextArrivalEl.hidden = true; heatmapEl.hidden = true; listEl.innerHTML = "";
    try {
      const res = await fetch(`/api/advanced/station-now/${encodeURIComponent(station)}?hours=${hours}`);
      const data = await res.json();
      if (data.error && !data.trains?.length) { setStatus(status, data.error, "is-error"); return; }
      setStatus(status, `${data.trains.length} train(s) reported in the next ${data.hours_window}h.`);

      if (data.next_arrival) {
        nextArrivalEl.hidden = false;
        nextArrivalEl.innerHTML = `<h4>Next to arrive: Train ${escapeHtml(String(data.next_arrival.train_number || "?"))}${data.next_arrival.train_name ? ` — ${escapeHtml(data.next_arrival.train_name)}` : ""}</h4>
          <p>${data.next_arrival.scheduled_time ? `Scheduled: ${escapeHtml(data.next_arrival.scheduled_time)}` : ""}${data.next_arrival.platform ? ` · Platform ${escapeHtml(String(data.next_arrival.platform))}` : ""}</p>`;
      }

      const hm = data.platform_heatmap;
      if (hm && hm.platform_data_available) {
        heatmapEl.hidden = false;
        heatmapEl.innerHTML = hm.platforms.map((p) => `<div class="platform-cell"><div class="platform-cell__label">Platform ${escapeHtml(String(p.platform))}</div><div class="platform-cell__count">${p.trains.length}</div></div>`).join("")
          + (hm.trains_without_reported_platform ? `<div class="platform-cell" style="background:#eef1f4;border-color:#ccc;"><div class="platform-cell__label" style="color:#6b7686;">Platform not reported</div><div class="platform-cell__count" style="color:#6b7686;">${hm.trains_without_reported_platform}</div></div>` : "");
      }

      data.trains.forEach((t) => {
        const li = document.createElement("li");
        li.innerHTML = `<span><strong>${escapeHtml(String(t.train_number || "?"))}</strong>${t.train_name ? ` — ${escapeHtml(t.train_name)}` : ""}${t.scheduled_time ? ` <span>(${escapeHtml(t.scheduled_time)})</span>` : ""}</span>${t.platform ? `<span class="result-tag">Platform ${escapeHtml(String(t.platform))}</span>` : `<span class="result-tag">platform not reported</span>`}`;
        listEl.appendChild(li);
      });
    } catch { setStatus(status, "Couldn't reach the backend just now.", "is-error"); }
  });

  // -------------------------------------------------------------
  // Personalized Journey Planner
  // -------------------------------------------------------------
  // Real Uber/Ola deep links — no partner API key needed for a deep
  // link, it just opens their app with pickup pre-filled. No fare/ETA
  // is shown here since that genuinely requires a partner API this
  // project doesn't have; the honest handoff is to let their own app
  // show live pricing.
  function buildUberLink(pickup, dropoff) {
    const p = new URLSearchParams();
    p.set("action", "setPickup");
    p.set("pickup[latitude]", pickup.lat);
    p.set("pickup[longitude]", pickup.lng);
    p.set("pickup[nickname]", pickup.name);
    if (dropoff) {
      p.set("dropoff[latitude]", dropoff.lat);
      p.set("dropoff[longitude]", dropoff.lng);
    }
    return `https://m.uber.com/ul/?${p.toString()}`;
  }
  function buildOlaLink(pickup, dropoff) {
    const p = new URLSearchParams();
    p.set("lat", pickup.lat);
    p.set("lng", pickup.lng);
    if (dropoff) { p.set("drop_lat", dropoff.lat); p.set("drop_lng", dropoff.lng); }
    return `olacabs://app/launch?${p.toString()}`;
  }

  let jpLastMileData = null;
  let jpDropoff = null;

  function renderJpLastMile() {
    const el = document.getElementById("jpLastMile");
    const heading = document.getElementById("jpLastMileHeading");
    if (!jpLastMileData || jpLastMileData.lat == null) { el.hidden = true; heading.hidden = true; return; }
    heading.hidden = false;
    el.hidden = false;
    const pickup = { lat: jpLastMileData.lat, lng: jpLastMileData.lng, name: jpLastMileData.name };
    el.innerHTML = `
      <p>${escapeHtml(jpLastMileData.name)} station as pickup.${jpDropoff ? " Using your current location as drop-off." : " No drop-off set — opens their app to pick one."}</p>
      <button type="button" class="tools-badge" id="jpUseLocationBtn" style="cursor:pointer;">📍 Use my current location as drop-off</button>
      <p><a href="${buildUberLink(pickup, jpDropoff)}" target="_blank" rel="noopener">🚗 Open in Uber</a> &nbsp; <a href="${buildOlaLink(pickup, jpDropoff)}">🚕 Open in Ola</a></p>`;
    const btn = document.getElementById("jpUseLocationBtn");
    if (btn) {
      btn.addEventListener("click", () => {
        if (!navigator.geolocation) { btn.textContent = "Location not available in this browser."; return; }
        btn.textContent = "Getting location…";
        navigator.geolocation.getCurrentPosition(
          (pos) => { jpDropoff = { lat: pos.coords.latitude, lng: pos.coords.longitude }; renderJpLastMile(); },
          () => { btn.textContent = "Couldn't get location — permission denied or unavailable."; },
        );
      });
    }
  }

  document.getElementById("journeyPlannerForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const source = document.getElementById("jpSourceInput").value.trim();
    const dest = document.getElementById("jpDestInput").value.trim();
    const date = toDDMMYYYY(document.getElementById("jpDateInput").value);
    const travelClass = document.getElementById("jpClassSelect").value;
    const preference = document.getElementById("jpPreferenceSelect").value;
    const status = document.getElementById("jpStatus");
    const noteEl = document.getElementById("jpNote");
    const directHeading = document.getElementById("jpDirectHeading");
    const directList = document.getElementById("jpDirectList");
    const altHeading = document.getElementById("jpAltHeading");
    const altList = document.getElementById("jpAltList");
    const altTransportHeading = document.getElementById("jpAltTransportHeading");
    const altTransportEl = document.getElementById("jpAltTransport");
    if (!source || !dest) return;
    setStatus(status, "Planning…");
    noteEl.hidden = true; directHeading.hidden = true; altHeading.hidden = true;
    directList.innerHTML = ""; altList.innerHTML = "";
    altTransportHeading.hidden = true; altTransportEl.hidden = true; altTransportEl.innerHTML = "";
    jpDropoff = null;
    try {
      const data = await postJSON("/api/journey/plan", {
        source, dest, date: date || null, preference, travel_class: travelClass || null, quota: "GN",
      });
      if (data.error) { setStatus(status, data.error, "is-error"); return; }
      setStatus(status, `${data.direct_options.length} direct train(s), ${data.alternative_routes.length} alternative route(s).`);

      const notes = [data.note, data.fare_note].filter(Boolean);
      if (notes.length) { noteEl.hidden = false; noteEl.textContent = notes.join(" "); }

      if (data.direct_options.length) {
        directHeading.hidden = false;
        data.direct_options.forEach((o) => {
          const li = document.createElement("li");
          const fareBit = o.fare != null ? `<span class="result-tag">₹${o.fare}</span>` : (o.fare_note ? `<span class="result-tag">${escapeHtml(o.fare_note)}</span>` : "");
          li.innerHTML = `<span><strong>${escapeHtml(o.train_number)}</strong>${o.train_name ? ` — ${escapeHtml(o.train_name)}` : ""} · dep ${escapeHtml(o.departure_time || "?")} → arr ${escapeHtml(o.arrival_time || "?")}${o.duration_display ? ` (${escapeHtml(o.duration_display)})` : ""}</span>${fareBit}`;
          directList.appendChild(li);
        });
      }

      if (data.alternative_routes.length) {
        altHeading.hidden = false;
        data.alternative_routes.forEach((r) => {
          const card = document.createElement("div");
          card.className = "tools-result-card";
          const legsHtml = r.legs.map((l) => l.train_found
            ? `<li><strong>${escapeHtml(l.from_name)}</strong> → <strong>${escapeHtml(l.to_name)}</strong>: train ${escapeHtml(l.train_number)}${l.train_name ? ` (${escapeHtml(l.train_name)})` : ""}, dep ${escapeHtml(l.departure_time || "?")} → arr ${escapeHtml(l.arrival_time || "?")}</li>`
            : `<li><strong>${escapeHtml(l.from_name)}</strong> → <strong>${escapeHtml(l.to_name)}</strong>: no confirmed train found for this leg</li>`
          ).join("");
          card.innerHTML = `<h4>Via ${escapeHtml(r.via_names.join(" → "))} <span class="tools-badge">${r.hops} change(s) · ~${r.total_distance_km} km</span></h4>
            <ul class="result-list">${legsHtml}</ul>
            ${!r.all_legs_confirmed ? `<p class="tools-disclaimer">One or more legs has no confirmed real train — the corridor exists, but no specific train was found for it.</p>` : ""}`;
          altList.appendChild(card);
        });
      }

      // FEATURE: Trip Planning with Alternative Transport (Bus/Flight) —
      // see backend/alt_transport.py. Only present when the backend found
      // no usable train option at all for this route/date.
      if (data.alt_transport) {
        const alt = data.alt_transport;
        altTransportHeading.hidden = false;
        altTransportEl.hidden = false;
        if (!alt.distance_known) {
          altTransportEl.innerHTML = `<p>${escapeHtml(alt.note || "Couldn't judge bus/flight suitability for this route.")}</p>`;
        } else {
          const guidanceHtml = (alt.guidance || []).map((g) => `
            <li>${g.mode === "flight" ? "✈️" : "🚌"} ${escapeHtml(g.text)}</li>
          `).join("");
          altTransportEl.innerHTML = `
            <h4>No train option found — ~${alt.rail_distance_km} km by rail distance</h4>
            <ul class="result-list">${guidanceHtml}</ul>
            <p class="tools-disclaimer">${escapeHtml(alt.disclaimer || "")}</p>`;
        }
      }

      jpLastMileData = data.last_mile && data.last_mile.dest_station ? data.last_mile.dest_station : null;
      renderJpLastMile();
    } catch { setStatus(status, "Couldn't reach the backend just now.", "is-error"); }
  });

  // -------------------------------------------------------------
  // Real-Time Delay Dashboard with Historical Patterns
  // -------------------------------------------------------------
  document.getElementById("delayHistoryForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const trainNumber = document.getElementById("dhTrainInput").value.trim();
    const days = document.getElementById("dhDaysSelect").value;
    const status = document.getElementById("dhStatus");
    const noteEl = document.getElementById("dhNote");
    const summaryEl = document.getElementById("dhWeekdaySummary");
    const daysHeading = document.getElementById("dhDaysHeading");
    const daysList = document.getElementById("dhDaysList");
    if (!/^\d{5}$/.test(trainNumber)) { setStatus(status, "Enter a valid 5-digit train number.", "is-error"); return; }
    setStatus(status, "Pulling real completed-journey history…");
    noteEl.hidden = true; summaryEl.innerHTML = ""; daysHeading.hidden = true; daysList.innerHTML = "";
    try {
      const res = await fetch(`/api/advanced/delay-history/${encodeURIComponent(trainNumber)}?days=${days}`);
      const data = await res.json();
      setStatus(status, `${data.days_with_data}/${data.lookback_days} recent days had real data.`);
      if (data.note) { noteEl.hidden = false; noteEl.textContent = data.note; }

      summaryEl.innerHTML = `<h4 class="tools-subheading">By weekday</h4>` + data.weekday_summary.map((w) => `
        <div class="platform-cell" style="min-width:90px;">
          <div class="platform-cell__label">${escapeHtml(w.weekday.slice(0,3))}</div>
          <div class="platform-cell__count">${w.avg_delay_minutes != null ? `${w.avg_delay_minutes}m` : "—"}</div>
          <div style="font-size:11px;color:#6b7686;">${w.samples} sample(s)</div>
        </div>`).join("");
      summaryEl.style.display = "flex"; summaryEl.style.flexWrap = "wrap"; summaryEl.style.gap = "8px";

      daysHeading.hidden = false;
      data.days.forEach((d) => {
        const li = document.createElement("li");
        const tag = d.data_available ? `<span class="result-tag">+${formatDelayDuration(d.delay_minutes)}</span>` : `<span class="result-tag" title="${escapeHtml(d.error || "")}">no data</span>`;
        li.innerHTML = `<span><strong>${escapeHtml(d.date)}</strong> (${escapeHtml(d.weekday)})</span>${tag}`;
        daysList.appendChild(li);
      });
      const firstUnmatched = data.days.find((d) => d.raw_keys && d.raw_keys.length);
      if (firstUnmatched) {
        const dbg = document.createElement("li");
        dbg.innerHTML = `<span style="font-size:12px;color:#8a8f98;">Provider returned data but no field matched a delay figure — real fields seen for ${escapeHtml(firstUnmatched.date)}: ${escapeHtml(firstUnmatched.raw_keys.join(", "))}</span>`;
        daysList.appendChild(dbg);
      }
    } catch { setStatus(status, "Couldn't reach the backend just now.", "is-error"); }
  });

  // -------------------------------------------------------------
  // PNR Auto-Tracking & Status Change Alerts
  // -------------------------------------------------------------
  const PNR_WATCHLIST_KEY = "pnrWatchlist";
  function loadPnrWatchlist() { try { return JSON.parse(localStorage.getItem(PNR_WATCHLIST_KEY)) || []; } catch { return []; } }
  function savePnrWatchlist(list) { localStorage.setItem(PNR_WATCHLIST_KEY, JSON.stringify(list)); }

  function renderPnrResult(el, d) {
    if (d.error) { el.hidden = false; el.innerHTML = `<p class="tools-disclaimer">${escapeHtml(d.error)}</p>`; return; }
    el.hidden = false;
    const passengers = (d.passengers || []).map((p) => `<p>Passenger ${p.number}: ${escapeHtml(p.current_status || "unknown")}${p.coach ? ` · Coach ${escapeHtml(p.coach)}` : ""}${p.berth ? ` · Berth ${escapeHtml(p.berth)}` : ""}</p>`).join("");
    const nothingMatched = !d.train_number && !d.overall_status_text && !d.from_station;
    const debugLine = nothingMatched && d.raw_keys && d.raw_keys.length
      ? `<p class="tools-disclaimer">Couldn't match any fields yet — real fields seen: ${escapeHtml(d.raw_keys.join(", "))}. Share this with support so the exact field names can be wired in.</p>`
      : "";
    el.innerHTML = `
      <h4>${escapeHtml(d.train_number || "?")}${d.train_name ? ` — ${escapeHtml(d.train_name)}` : ""} <span class="tools-badge">${escapeHtml(d.overall_status_text || "status unknown")}</span></h4>
      <p>${d.from_station ? escapeHtml(d.from_station) : "?"} → ${d.to_station ? escapeHtml(d.to_station) : "?"}${d.date_of_journey ? ` · ${escapeHtml(d.date_of_journey)}` : ""}${d.class ? ` · ${escapeHtml(d.class)}` : ""}</p>
      <p>Chart: ${d.chart_prepared == null ? "unknown" : (d.chart_prepared ? "prepared" : "not yet prepared")}</p>
      ${passengers}
      ${debugLine}`;
  }

  function renderPnrWatchlist() {
    const list = loadPnrWatchlist();
    const el = document.getElementById("pnrWatchList");
    el.innerHTML = "";
    list.forEach((entry) => {
      const li = document.createElement("li");
      li.innerHTML = `<span><strong>${escapeHtml(entry.label || entry.pnr)}</strong> (${escapeHtml(entry.pnr)}) — ${escapeHtml(entry.last_known_status || "not checked yet")}</span><button type="button" data-pnr="${escapeHtml(entry.pnr)}" class="tools-badge" style="cursor:pointer;">Remove</button>`;
      li.querySelector("button").addEventListener("click", () => {
        savePnrWatchlist(loadPnrWatchlist().filter((e) => e.pnr !== entry.pnr));
        renderPnrWatchlist();
      });
      el.appendChild(li);
    });
  }
  renderPnrWatchlist();

  document.getElementById("pnrLookupForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pnr = document.getElementById("pnrInput").value.trim();
    const status = document.getElementById("pnrStatus");
    const result = document.getElementById("pnrResult");
    if (!/^\d{10}$/.test(pnr)) { setStatus(status, "Enter a valid 10-digit PNR.", "is-error"); return; }
    setStatus(status, "Checking…");
    result.hidden = true;
    try {
      const res = await fetch(`/api/pnr/status/${encodeURIComponent(pnr)}`);
      const data = await res.json();
      setStatus(status, "");
      renderPnrResult(result, data);
    } catch { setStatus(status, "Couldn't reach the backend just now.", "is-error"); }
  });

  document.getElementById("pnrAddWatchBtn").addEventListener("click", () => {
    const pnr = document.getElementById("pnrInput").value.trim();
    const label = document.getElementById("pnrLabelInput").value.trim();
    const status = document.getElementById("pnrStatus");
    if (!/^\d{10}$/.test(pnr)) { setStatus(status, "Enter a valid 10-digit PNR first.", "is-error"); return; }
    const list = loadPnrWatchlist();
    if (list.some((e) => e.pnr === pnr)) { setStatus(status, "Already on your watchlist.", "is-error"); return; }
    list.push({ pnr, label, last_known_status: null });
    savePnrWatchlist(list);
    renderPnrWatchlist();
    setStatus(status, "Added to watchlist.");
  });

  document.getElementById("pnrRefreshWatchBtn").addEventListener("click", async () => {
    const list = loadPnrWatchlist();
    const status = document.getElementById("pnrWatchStatus");
    if (!list.length) { setStatus(status, "Watchlist is empty — add a PNR above.", "is-error"); return; }
    setStatus(status, "Refreshing…");
    try {
      const data = await postJSON("/api/pnr/watchlist/check", { entries: list });
      const changed = [];
      const updated = list.map((entry) => {
        const row = data.results.find((r) => r.pnr === entry.pnr);
        if (!row) return entry;
        if (row.status_changed) changed.push(entry.label || entry.pnr);
        return { ...entry, last_known_status: row.overall_status_text || entry.last_known_status };
      });
      savePnrWatchlist(updated);
      renderPnrWatchlist();
      setStatus(status, changed.length ? `🔔 Status changed for: ${changed.join(", ")}` : "Refreshed — no status changes.", changed.length ? "is-live" : "");
    } catch { setStatus(status, "Couldn't reach the backend just now.", "is-error"); }
  });

  // -------------------------------------------------------------
  // Train Delay Prediction with Explainable AI
  // -------------------------------------------------------------
  document.getElementById("delayExplainForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const trainNumber = document.getElementById("deTrainInput").value.trim();
    const date = toDDMMYYYY(document.getElementById("deDateInput").value);
    const time = document.getElementById("deTimeInput").value;
    const travelClass = document.getElementById("deClassSelect").value;
    const currentDelayRaw = document.getElementById("deCurrentDelayInput").value;
    const status = document.getElementById("deStatus");
    const result = document.getElementById("deResult");
    setStatus(status, "Running the ensemble + SHAP attribution…");
    result.hidden = true;
    try {
      const data = await postJSON("/api/delay/explain", {
        train_number: trainNumber || null,
        date: date || null,
        time: time || null,
        travel_class: travelClass || null,
        current_delay_minutes: currentDelayRaw ? parseInt(currentDelayRaw, 10) : null,
        include_historical: !!trainNumber,
      });
      setStatus(status, "");
      result.hidden = false;

      const basisHtml = (data.basis || []).map((b) => `<li>${escapeHtml(b)}</li>`).join("");
      const narrativeHtml = (data.narrative || []).map((n) => `<li><strong>${escapeHtml(n)}</strong></li>`).join("");

      const barsHtml = (data.attributions || []).map((a) => {
        const isUp = a.minutes >= 0;
        const dirClass = isUp ? "is-up" : "is-down";
        const arrow = isUp ? "▲" : "▼";
        const widthPct = Math.max(4, a.pct_of_total);
        return `
          <div class="shap-bar-row">
            <div class="shap-bar-top">
              <span class="shap-bar-label">${arrow} ${escapeHtml(a.label)}${a.is_shap ? "" : " •"}</span>
              <span class="shap-bar-minutes ${dirClass}">${isUp ? "+" : ""}${a.minutes.toFixed(1)} min</span>
            </div>
            <div class="shap-bar-track"><div class="shap-bar-fill ${dirClass}" style="width:${widthPct}%;"></div></div>
            <div class="shap-bar-pct">${a.pct_of_total}% of total attribution</div>
          </div>`;
      }).join("");

      const historicalHtml = data.historical_headline
        ? `<div class="historical-callout">📅 ${escapeHtml(data.historical_headline)}</div>` : "";

      const shapErrorHtml = data.shap_error
        ? `<p class="tools-disclaimer">Per-factor breakdown unavailable this time (${escapeHtml(data.shap_error)}) — the headline estimate above is still real.</p>` : "";

      result.innerHTML = `
        <h4>~${formatDelayDuration(data.predicted_delay_minutes)} <span class="tools-badge">${escapeHtml(data.confidence)} confidence</span></h4>
        <p>Range: ${formatDelayDuration(data.predicted_delay_low_minutes)}–${formatDelayDuration(data.predicted_delay_high_minutes)}${data.current_station ? ` · Currently near ${escapeHtml(data.current_station)}` : ""}</p>
        <p style="font-size:12px;color:#5a6675;">${escapeHtml(data.model_name || "")}</p>
        <ul class="result-list">${basisHtml}</ul>
        ${historicalHtml}
        <h4 class="tools-subheading" style="margin-top:14px;">⚖️ Why this prediction — Explainable AI (${escapeHtml(data.explainer_method || "SHAP")})</h4>
        <ul class="result-list">${narrativeHtml}</ul>
        ${barsHtml}
        <div class="shap-legend">▲ Red = adds to the predicted delay · ▼ Green = reduces it. "•" marks the weather line, added on top of the model's own estimate rather than SHAP-attributed.</div>
        ${shapErrorHtml}
        <p class="tools-disclaimer">${escapeHtml(data.disclaimer || "")}</p>`;
    } catch { setStatus(status, "Couldn't reach the backend just now.", "is-error"); }
  });

  // -------------------------------------------------------------
  // Crowd-Sourced Train Position Reports
  // -------------------------------------------------------------
  const CP_REPORTER_ID_KEY = "railwayRagReporterId";
  function getCpReporterId() {
    let id = localStorage.getItem(CP_REPORTER_ID_KEY);
    if (!id) {
      // Anonymous per-browser id, same "no login system" pattern the rest
      // of this app uses for push-notification device tokens — identifies
      // THIS BROWSER for badge counting and report clustering, not a
      // person. Not a crypto RNG on purpose; only needs practical
      // uniqueness for that.
      id = "web-" + Array.from({ length: 20 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
      localStorage.setItem(CP_REPORTER_ID_KEY, id);
    }
    return id;
  }

  const CP_SOURCE_COLOR = {
    official_confirmed_by_crowd: "#2E8B57",  // --go-green
    official: "#16324F",                      // --rail-steel
    crowd_sourced: "#FFB300",                 // --signal-amber
    crowd_sourced_unconfirmed: "#8a93a1",
    unavailable: "#8a93a1",
  };

  let cpMap = null, cpMarker = null, cpCircle = null;

  function renderCpBadgeCard(stats) {
    const el = document.getElementById("cpBadgeCard");
    if (!stats) { el.textContent = "Submit a position report to start earning badges."; return; }
    const nextLine = stats.next_badge
      ? `Next: <strong>${escapeHtml(stats.next_badge.next_badge)}</strong> in ${stats.next_badge.reports_needed} more report(s)`
      : "Top tier reached!";
    el.innerHTML = `
      <p>Reports submitted: <strong>${stats.total_reports}</strong></p>
      <p>Badge: <span class="cp-badge-pill">${stats.badge ? escapeHtml(stats.badge) : "None yet"}</span></p>
      <p style="font-size:12px;color:#5a6675;">${nextLine}</p>`;
  }

  async function refreshCpLeaderboard() {
    const status = document.getElementById("cpLeaderboardStatus");
    const list = document.getElementById("cpLeaderboardList");
    try {
      const res = await fetch("/api/crowd-position/leaderboard/top?limit=10");
      const data = await res.json();
      setStatus(status, `${data.stats?.total_reports || 0} reports from ${data.stats?.registered_reporters || 0} devices so far.`);
      list.innerHTML = "";
      const myId = getCpReporterId();
      (data.leaderboard || []).forEach((r, i) => {
        const li = document.createElement("li");
        li.innerHTML = `
          <div class="cp-leader-row">
            <span class="cp-leader-rank">#${i + 1}</span>
            <span class="cp-leader-name">${escapeHtml(r.display_name || r.reporter_id.slice(0, 10) + "…")}${r.reporter_id === myId ? " (you)" : ""}</span>
            <span class="cp-badge-pill">${r.badge ? escapeHtml(r.badge) : "—"}</span>
            <span class="cp-leader-count">${r.total_reports}</span>
          </div>`;
        list.appendChild(li);
      });
    } catch { setStatus(status, "Couldn't load the leaderboard just now.", "is-error"); }
  }
  refreshCpLeaderboard();
  getReporterCpStats();

  async function getReporterCpStats() {
    try {
      const res = await fetch(`/api/crowd-position/reporter/${encodeURIComponent(getCpReporterId())}`);
      renderCpBadgeCard(await res.json());
    } catch { /* non-fatal — badge card just stays at its default text */ }
  }

  document.getElementById("crowdPositionForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const trainNumber = document.getElementById("cpTrainInput").value.trim();
    const date = toDDMMYYYY(document.getElementById("cpDateInput").value);
    const status = document.getElementById("cpStatus");
    const wrap = document.getElementById("cpResultWrap");
    const result = document.getElementById("cpResult");
    if (!/^\d{5}$/.test(trainNumber)) { setStatus(status, "Enter a valid 5-digit train number.", "is-error"); return; }
    setStatus(status, "Fusing official position with recent passenger reports…");
    try {
      const qs = date ? `?date=${encodeURIComponent(date)}` : "";
      const res = await fetch(`/api/crowd-position/${encodeURIComponent(trainNumber)}${qs}`);
      const data = await res.json();
      setStatus(status, "");
      wrap.hidden = false;

      if (data.lat != null && data.lng != null) {
        const color = CP_SOURCE_COLOR[data.position_source] || "#16324F";
        if (!cpMap) {
          cpMap = L.map("cpMap", { scrollWheelZoom: false });
        }
        cpMap.setView([data.lat, data.lng], 13);
        if (cpMarker) cpMap.removeLayer(cpMarker);
        if (cpCircle) cpMap.removeLayer(cpCircle);
        cpMarker = L.circleMarker([data.lat, data.lng], { radius: 8, color, fillColor: color, fillOpacity: 0.9 })
          .addTo(cpMap).bindPopup(escapeHtml(data.confidence_label));
        if (data.uncertainty_radius_m) {
          cpCircle = L.circle([data.lat, data.lng], {
            radius: data.uncertainty_radius_m, color, fillColor: color, fillOpacity: 0.12, weight: 1,
          }).addTo(cpMap);
        }
        setTimeout(() => cpMap.invalidateSize(), 100);
      }

      result.innerHTML = `
        <h4>${escapeHtml(data.confidence_label || "No position available")}</h4>
        <p>Source: <span class="tools-badge">${escapeHtml(data.position_source)}</span></p>
        <p>Confirming reports: ${data.n_confirming_reports} of ${data.n_total_reports} recent</p>
        ${data.uncertainty_radius_m != null ? `<p>Uncertainty radius: ~${data.uncertainty_radius_m} m</p>` : ""}
        ${data.current_station ? `<p>Current station: ${escapeHtml(data.current_station)}</p>` : ""}
        <p class="tools-disclaimer">${escapeHtml(data.disclaimer || "")}</p>`;
    } catch { setStatus(status, "Couldn't reach the backend just now.", "is-error"); }
  });

  document.getElementById("cpReportBtn").addEventListener("click", () => {
    const trainNumber = document.getElementById("cpTrainInput").value.trim();
    const date = toDDMMYYYY(document.getElementById("cpDateInput").value);
    const status = document.getElementById("cpStatus");
    if (!/^\d{5}$/.test(trainNumber)) { setStatus(status, "Enter a valid 5-digit train number first.", "is-error"); return; }
    if (!navigator.geolocation) { setStatus(status, "This browser doesn't support geolocation.", "is-error"); return; }
    setStatus(status, "Getting your location…");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const result = await postJSON("/api/crowd-position/report", {
            train_number: trainNumber,
            reporter_id: getCpReporterId(),
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy_meters: pos.coords.accuracy || null,
            date: date || null,
          });
          renderCpBadgeCard(result);
          setStatus(status, result.badge
            ? `Thanks! You're a ${result.badge} (${result.total_reports} reports total).`
            : `Thanks! ${result.total_reports} report(s) submitted so far.`, "is-live");
          refreshCpLeaderboard();
        } catch { setStatus(status, "Couldn't reach the backend just now.", "is-error"); }
      },
      (err) => { setStatus(status, `Location permission denied or unavailable (${err.message}).`, "is-error"); },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  // ============================================================
  // FEATURE 1: "When Should I Leave?" Smart Departure Reminder
  // ============================================================
  let depPendingCoords = null;
  document.getElementById("depUseLocationBtn").addEventListener("click", () => {
    const status = document.getElementById("departureStatus");
    if (!navigator.geolocation) { setStatus(status, "This browser doesn't support geolocation.", "is-error"); return; }
    setStatus(status, "Getting your location…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        depPendingCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        document.getElementById("depDistanceInput").value = "";
        setStatus(status, "Got your location — now click \"When should I leave?\"", "is-live");
      },
      (err) => { setStatus(status, `Location permission denied or unavailable (${err.message}).`, "is-error"); },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
  document.getElementById("departureForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const trainNumber = document.getElementById("depTrainInput").value.trim();
    const boardingStation = document.getElementById("depStationInput").value.trim().toUpperCase();
    const date = toDDMMYYYY(document.getElementById("depDateInput").value);
    const mode = document.getElementById("depModeSelect").value;
    const bufferMin = parseInt(document.getElementById("depBufferInput").value, 10) || 0;
    const distanceRaw = document.getElementById("depDistanceInput").value;
    const status = document.getElementById("departureStatus");
    const result = document.getElementById("departureResult");
    if (!/^\d{5}$/.test(trainNumber) || !boardingStation) { setStatus(status, "Enter a valid train number and boarding station.", "is-error"); return; }
    setStatus(status, "Checking the train's live departure time…");
    result.hidden = true;
    const body = {
      train_number: trainNumber, boarding_station: boardingStation, date: date || null,
      mode, boarding_buffer_minutes: bufferMin,
      distance_km: distanceRaw ? parseFloat(distanceRaw) : null,
      user_lat: distanceRaw ? null : depPendingCoords?.lat ?? null,
      user_lng: distanceRaw ? null : depPendingCoords?.lng ?? null,
    };
    try {
      const data = await postJSON("/api/advanced/departure-reminder", body);
      setStatus(status, "");
      result.hidden = false;
      if (!data.found) { result.innerHTML = `<p>${escapeHtml(data.note || "Couldn't find that train/station.")}</p>`; return; }
      if (!data.leave_by) {
        result.innerHTML = `<p>${escapeHtml(data.note || "Give a distance or your location to get a leave-by time.")}</p>`;
        return;
      }
      result.innerHTML = `
        <h4>Leave by ${escapeHtml(data.leave_by)} <span class="tools-urgency tools-urgency--${data.urgency}">${data.urgency.replace(/_/g, " ")}</span></h4>
        <p>Departure (${escapeHtml(data.station)}): scheduled ${escapeHtml(data.scheduled_departure || "?")}${data.expected_departure && data.expected_departure !== data.scheduled_departure ? `, expected ${escapeHtml(data.expected_departure)}` : ""}${data.delay_minutes ? ` (+${formatDelayDuration(data.delay_minutes)})` : ""}</p>
        <p>${data.distance_km} km by ${escapeHtml(data.mode)} (~${data.assumed_speed_kmph} km/h) ≈ ${data.travel_minutes} min travel + ${data.boarding_buffer_minutes} min buffer</p>
        <p>${data.minutes_until_leave > 0 ? `You have about <strong>${data.minutes_until_leave} min</strong> before you should leave.` : `You're <strong>${Math.abs(data.minutes_until_leave)} min</strong> past the recommended leave time.`}</p>
        <div class="tools-disclaimer">${escapeHtml(data.disclaimer)}</div>`;
    } catch { setStatus(status, "Couldn't reach the backend just now.", "is-error"); }
  });

  // ============================================================
  // FEATURE 9: "Platform Finder" with Indoor Navigation
  // ============================================================
  document.getElementById("platformNavForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const station = document.getElementById("pnStationInput").value.trim().toUpperCase();
    const platformRaw = document.getElementById("pnPlatformInput").value;
    const trainNumber = document.getElementById("pnTrainInput").value.trim();
    const entryPoint = document.getElementById("pnEntryInput").value.trim();
    const status = document.getElementById("platformNavStatus");
    const result = document.getElementById("platformNavResult");
    if (!station || (!platformRaw && !trainNumber)) { setStatus(status, "Enter a station, and either a platform number or a train number.", "is-error"); return; }
    setStatus(status, "Working out the route…");
    result.hidden = true;
    try {
      const data = await postJSON("/api/advanced/platform-navigate", {
        station, platform_number: platformRaw ? parseInt(platformRaw, 10) : null,
        train_number: trainNumber || null, entry_point: entryPoint || null,
      });
      setStatus(status, "");
      result.hidden = false;
      result.innerHTML = `
        <h4>To Platform ${data.platform_number} <span class="tools-badge">~${data.estimated_walk_minutes} min walk</span></h4>
        ${data.platform_source === "predicted_from_train_number" ? `<p class="result-tag">Platform predicted from train number (${escapeHtml(data.platform_predict_confidence || "")})</p>` : ""}
        <ol>${data.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ol>
        ${data.nearby_amenities_note ? `<p>${escapeHtml(data.nearby_amenities_note)}</p>` : ""}
        <div class="tools-disclaimer">${escapeHtml(data.disclaimer)}</div>`;
    } catch { setStatus(status, "Couldn't reach the backend just now.", "is-error"); }
  });

  // ============================================================
  // FEATURE 3: "Smart Alarm" Based on Real-Time Train Position
  // ============================================================
  let saAutoTimer = null;
  let saAlarmPreciseTimeoutId = null;
  let saAlarmFired = false;
  async function runSmartAlarmCheck() {
    const trainNumber = document.getElementById("saTrainInput").value.trim();
    const destStation = document.getElementById("saStationInput").value.trim().toUpperCase();
    const date = toDDMMYYYY(document.getElementById("saDateInput").value);
    const leadMinutes = parseFloat(document.getElementById("saLeadMinutesInput").value) || 10;
    const status = document.getElementById("smartAlarmStatus");
    const result = document.getElementById("smartAlarmResult");
    if (!/^\d{5}$/.test(trainNumber) || !destStation) { setStatus(status, "Enter a valid train number and destination station.", "is-error"); return; }
    setStatus(status, "Checking live position…");
    try {
      const data = await postJSON("/api/advanced/smart-alarm", {
        train_number: trainNumber, destination_station: destStation, date: date || null, lead_minutes: leadMinutes,
      });
      result.hidden = false;
      if (!data.found) { setStatus(status, ""); result.innerHTML = `<p>${escapeHtml(data.note || "Couldn't check this train.")}</p>`; return; }
      if (data.already_passed) { setStatus(status, ""); result.innerHTML = `<p>${escapeHtml(data.note)}</p>`; return; }
      if (data.note && !data.scheduled_arrival && !data.expected_arrival) { setStatus(status, ""); result.innerHTML = `<p>${escapeHtml(data.note)}</p>`; return; }
      setStatus(status, data.alarm_now ? "🔔 Time to get ready!" : "", data.alarm_now ? "is-live" : undefined);
      if (saAlarmPreciseTimeoutId) { clearTimeout(saAlarmPreciseTimeoutId); saAlarmPreciseTimeoutId = null; }
      if (data.alarm_now && !saAlarmFired) {
        saAlarmFired = true;
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          new Notification(`Approaching ${destStation}`, { body: `Train ${trainNumber} is close — get ready to alight.` });
        } else if (typeof Notification !== "undefined" && Notification.permission === "default") {
          Notification.requestPermission();
        }
      } else if (!data.alarm_now) {
        saAlarmFired = false;
        // Wake up (on this device's own real clock) exactly when the
        // server-computed real due moment (alarm_at_iso, from RailKit's
        // live ETA) arrives, instead of waiting for the next 60s auto-check
        // tick to happen to notice it.
        if (data.alarm_at_iso) {
          const dueAt = new Date(data.alarm_at_iso).getTime();
          const msUntilDue = dueAt - Date.now();
          if (!Number.isNaN(dueAt) && msUntilDue > 0) {
            saAlarmPreciseTimeoutId = setTimeout(runSmartAlarmCheck, msUntilDue);
          }
        }
      }
      result.innerHTML = `
        <h4>${data.alarm_now ? "🔔 Get ready — you're close!" : "Not yet"}</h4>
        <p>Arrival at ${escapeHtml(data.station)}: scheduled ${escapeHtml(data.scheduled_arrival || "?")}${data.expected_arrival && data.expected_arrival !== data.scheduled_arrival ? `, expected ${escapeHtml(data.expected_arrival)}` : ""}${data.delay_minutes ? ` (+${formatDelayDuration(data.delay_minutes)})` : ""}</p>
        ${data.minutes_remaining != null ? `<p>~${data.minutes_remaining} min remaining</p>` : ""}
        ${data.distance_remaining_km != null ? `<p>~${data.distance_remaining_km} km remaining</p>` : ""}
        <div class="tools-disclaimer">${escapeHtml(data.disclaimer)}</div>`;
    } catch { setStatus(status, "Couldn't reach the backend just now.", "is-error"); }
  }
  document.getElementById("smartAlarmForm").addEventListener("submit", (e) => { e.preventDefault(); runSmartAlarmCheck(); });
  document.getElementById("saAutoCheckbox").addEventListener("change", (e) => {
    if (saAutoTimer) { clearInterval(saAutoTimer); saAutoTimer = null; }
    if (saAlarmPreciseTimeoutId) { clearTimeout(saAlarmPreciseTimeoutId); saAlarmPreciseTimeoutId = null; }
    saAlarmFired = false;
    if (e.target.checked) {
      if (typeof Notification !== "undefined" && Notification.permission === "default") Notification.requestPermission();
      saAutoTimer = setInterval(runSmartAlarmCheck, 60000);
      runSmartAlarmCheck();
    }
  });

  // ============================================================
  // FEATURE 5: "Transit Time Optimizer"
  // ============================================================
  document.getElementById("transitOptForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const source = document.getElementById("toSourceInput").value.trim().toUpperCase();
    const dest = document.getElementById("toDestInput").value.trim().toUpperCase();
    const date = toDDMMYYYY(document.getElementById("toDateInput").value);
    const status = document.getElementById("transitOptStatus");
    const result = document.getElementById("transitOptResult");
    if (!source || !dest) { setStatus(status, "Enter both stations.", "is-error"); return; }
    setStatus(status, "Ranking trains against your schedule…");
    result.hidden = true;
    try {
      const data = await postJSON("/api/advanced/transit-optimizer", {
        source, dest, date: date || null,
        depart_after: document.getElementById("toDepartAfterInput").value || null,
        depart_before: document.getElementById("toDepartBeforeInput").value || null,
        arrive_after: document.getElementById("toArriveAfterInput").value || null,
        arrive_before: document.getElementById("toArriveBeforeInput").value || null,
        preferred_arrival: document.getElementById("toPreferredArrivalInput").value || null,
        max_duration_hours: parseFloat(document.getElementById("toMaxDurationInput").value) || null,
      });
      setStatus(status, "");
      result.hidden = false;
      if (data.error) { result.innerHTML = `<p>${escapeHtml(data.error)}</p>`; return; }
      if (!data.trains.length) { result.innerHTML = "<p>No trains found on this route.</p>"; return; }
      result.innerHTML = data.trains.slice(0, 15).map((t, i) => `
        <div style="padding:8px 0;${i > 0 ? "border-top:1px solid #e4dcc7;" : ""}">
          <strong>#${i + 1} ${escapeHtml(t.train_number)} — ${escapeHtml(t.train_name || "")}</strong>
          ${!t.fits_schedule ? `<span class="tools-badge is-no">outside your window</span>` : ""}
          <p>Departs ${escapeHtml(t.source_departure || "?")} → Arrives ${escapeHtml(t.dest_arrival || "?")} (${escapeHtml(t.duration || "?")})</p>
          ${t.why.length ? `<ul>${t.why.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>` : ""}
        </div>`).join("");
    } catch { setStatus(status, "Couldn't reach the backend just now.", "is-error"); }
  });

  // ============================================================
  // FEATURE 6: "Route Visualization" with Time-Lapse
  // ============================================================
  let tlMap = null, tlMarker = null, tlStops = [], tlPlaying = false, tlTimer = null;
  function tlPositionAt(progressPct) {
    if (!tlStops.length) return null;
    const target = progressPct / 1000;
    let before = tlStops[0], after = tlStops[tlStops.length - 1];
    for (let i = 0; i < tlStops.length - 1; i++) {
      if (tlStops[i].progress <= target && tlStops[i + 1].progress >= target) { before = tlStops[i]; after = tlStops[i + 1]; break; }
    }
    const span = (after.progress - before.progress) || 1;
    const ratio = Math.min(1, Math.max(0, (target - before.progress) / span));
    return {
      lat: before.lat + (after.lat - before.lat) * ratio,
      lng: before.lng + (after.lng - before.lng) * ratio,
      nearStop: ratio < 0.5 ? before : after,
    };
  }
  function tlRenderAtScrubber() {
    const scrubber = document.getElementById("tlScrubber");
    const pos = tlPositionAt(parseInt(scrubber.value, 10));
    if (!pos || !tlMap) return;
    if (!tlMarker) tlMarker = L.marker([pos.lat, pos.lng]).addTo(tlMap);
    else tlMarker.setLatLng([pos.lat, pos.lng]);
    tlMap.panTo([pos.lat, pos.lng]);
    document.getElementById("tlStopInfo").innerHTML =
      `<p>Nearest stop: <strong>${escapeHtml(pos.nearStop.name)}</strong> (${escapeHtml(pos.nearStop.code)})${pos.nearStop.scheduled_arrival ? ` — sch. arr. ${escapeHtml(pos.nearStop.scheduled_arrival)}` : ""}${pos.nearStop.scheduled_departure ? `, sch. dep. ${escapeHtml(pos.nearStop.scheduled_departure)}` : ""}</p>`;
  }
  document.getElementById("tlScrubber").addEventListener("input", tlRenderAtScrubber);
  document.getElementById("tlPlayBtn").addEventListener("click", () => {
    const btn = document.getElementById("tlPlayBtn");
    const scrubber = document.getElementById("tlScrubber");
    if (tlPlaying) { clearInterval(tlTimer); tlTimer = null; tlPlaying = false; btn.textContent = "▶️ Play"; return; }
    tlPlaying = true; btn.textContent = "⏸️ Pause";
    if (parseInt(scrubber.value, 10) >= 1000) scrubber.value = 0;
    const totalMs = parseInt(document.getElementById("tlSpeedSelect").value, 10);
    const stepMs = 100;
    const stepAmount = 1000 / (totalMs / stepMs);
    tlTimer = setInterval(() => {
      let v = parseFloat(scrubber.value) + stepAmount;
      if (v >= 1000) { v = 1000; clearInterval(tlTimer); tlTimer = null; tlPlaying = false; btn.textContent = "▶️ Play"; }
      scrubber.value = v;
      tlRenderAtScrubber();
    }, stepMs);
  });
  document.getElementById("timelapseForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const trainNumber = document.getElementById("tlTrainInput").value.trim();
    const status = document.getElementById("timelapseStatus");
    const wrap = document.getElementById("timelapseWrap");
    if (!/^\d{5}$/.test(trainNumber)) { setStatus(status, "Enter a valid 5-digit train number.", "is-error"); return; }
    setStatus(status, "Loading route…");
    if (tlTimer) { clearInterval(tlTimer); tlTimer = null; tlPlaying = false; document.getElementById("tlPlayBtn").textContent = "▶️ Play"; }
    try {
      const res = await fetch(`/api/advanced/route-timelapse/${encodeURIComponent(trainNumber)}`);
      const data = await res.json();
      if (!data.found) { setStatus(status, data.note || "Couldn't load this train's route.", "is-error"); wrap.hidden = true; return; }
      tlStops = data.stops.filter((s) => s.lat != null && s.lng != null && s.progress != null);
      if (tlStops.length < 2) { setStatus(status, "Not enough plottable stops on this route to animate.", "is-error"); wrap.hidden = true; return; }
      setStatus(status, `${data.total_stops} stops loaded (${data.plottable_stops} plottable) — ${data.progress_basis === "distance" ? "paced by real distance" : "evenly spaced (no real distance data)"}.`);
      wrap.hidden = false;
      if (!tlMap) tlMap = L.map("tlMap", { scrollWheelZoom: false });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap" }).addTo(tlMap);
      const latlngs = tlStops.map((s) => [s.lat, s.lng]);
      tlMap.fitBounds(latlngs);
      L.polyline(latlngs, { color: "#16324F", weight: 3 }).addTo(tlMap);
      tlStops.forEach((s) => L.circleMarker([s.lat, s.lng], { radius: 4, color: "#8a93a1" }).addTo(tlMap).bindPopup(`${escapeHtml(s.name)} (${escapeHtml(s.code)})`));
      document.getElementById("tlScrubber").value = 0;
      if (tlMarker) { tlMap.removeLayer(tlMarker); tlMarker = null; }
      tlRenderAtScrubber();
      setTimeout(() => tlMap.invalidateSize(), 100);
    } catch { setStatus(status, "Couldn't reach the backend just now.", "is-error"); }
  });

  // NOTE: "Live Crowd Map for Train Coaches" and "Water/Restroom
  // Availability Live Check" were removed — neither RailKit (RapidAPI) nor
  // RailRadar publishes any real per-coach occupancy or water/restroom
  // sensor feed this app can reach.

  // -------------------------------------------------------------
  // FEATURE: "Optimal Booking Window" Predictor
  // -------------------------------------------------------------
  document.getElementById("bookingWindowForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const trainNumber = document.getElementById("bwTrainInput").value.trim();
    const source = document.getElementById("bwSourceInput").value.trim().toUpperCase();
    const dest = document.getElementById("bwDestInput").value.trim().toUpperCase();
    const date = toDDMMYYYY(document.getElementById("bwDateInput").value);
    const travelClass = document.getElementById("bwClassSelect").value;
    const status = document.getElementById("bookingWindowStatus");
    const result = document.getElementById("bookingWindowResult");
    if (!/^\d{5}$/.test(trainNumber)) { setStatus(status, "Enter a valid 5-digit train number.", "is-error"); return; }
    setStatus(status, "Checking booking rules + live availability…");
    result.hidden = true;
    try {
      const data = await postJSON("/api/advanced/booking-window", { train_number: trainNumber, source, dest, date, travel_class: travelClass });
      setStatus(status, "");
      result.hidden = false;
      const urgencyLabel = { open: "🟢 Open", tightening: "🟡 Tightening", tight: "🔴 Tight", unknown: "No live status" }[data.urgency] || "";
      const crowd = data.session_crowd_trend;
      const crowdHtml = crowd
        ? `<p class="tools-disclaimer">${crowd.note} (${crowd.points_this_session} point(s) logged this session.)</p>`
        : "";
      result.innerHTML = `
        <h4>${escapeHtml(trainNumber)} ${escapeHtml(source)} → ${escapeHtml(dest)} (${escapeHtml(travelClass)}) <span class="tools-badge">${urgencyLabel}</span></h4>
        ${data.days_until_departure != null ? `<p>${data.days_until_departure} day(s) until departure.</p>` : ""}
        <ul>${data.advice.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul>
        ${crowdHtml}
        <div class="tools-disclaimer">${escapeHtml(data.disclaimer)}</div>`;
    } catch { setStatus(status, "Couldn't reach the backend just now.", "is-error"); }
  });

  // -------------------------------------------------------------
  // FEATURE: "Station Navigator" — Point of Interest Finder (More Tools
  // standalone lookup — see also the Live Tracking tab's own "Station
  // facilities at current station" button, wired in the other IIFE, which
  // calls the same /api/advanced/station-navigator/{code} endpoint).
  // -------------------------------------------------------------
  document.getElementById("stationNavForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const stationCode = document.getElementById("stationNavInput").value.trim().toUpperCase();
    const status = document.getElementById("stationNavStatus");
    const result = document.getElementById("stationNavResult");
    setStatus(status, "Looking up…");
    result.hidden = true;
    try {
      const res = await fetch(`/api/advanced/station-navigator/${encodeURIComponent(stationCode)}`);
      const data = await res.json();
      setStatus(status, "");
      result.hidden = false;
      const entrances = (data.entrance_sides || []).length
        ? `<ul>${data.entrance_sides.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>` : "";
      const facilities = (data.facilities || []).length
        ? `<ul>${data.facilities.map((f) => `<li><strong>${escapeHtml(f.label)}</strong> — ${escapeHtml(f.typical_location_note)}</li>`).join("")}</ul>`
        : `<p>No curated facility list for this station.</p>`;
      result.innerHTML = `
        <h4>${escapeHtml(data.name || data.station)} <span class="tools-badge">${data.station_platform_count} platform(s)${data.platform_count_basis === "known" ? "" : " (estimated)"}</span></h4>
        ${data.notable_note ? `<p>${escapeHtml(data.notable_note)}</p>` : ""}
        ${entrances ? `<p><strong>Entrance sides:</strong></p>${entrances}` : ""}
        <p><strong>Facilities:</strong></p>
        ${facilities}
        <p><strong>Layout guidance:</strong></p>
        <ul>${(data.layout_guidance || []).map((g) => `<li>${escapeHtml(g)}</li>`).join("")}</ul>
        <div class="tools-disclaimer">${escapeHtml(data.disclaimer || "")}</div>`;
    } catch { setStatus(status, "Couldn't reach the backend just now.", "is-error"); }
  });
})();