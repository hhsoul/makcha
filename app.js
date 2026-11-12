/* 막차알림 — 대중교통 막차 알림 웹앱
 * 모든 시간·요금은 거리 기반 추정치입니다. (실시간 시간표 API 미사용)
 * 정확한 막차 시각은 설정에서 직접 입력하면 그 값을 우선 사용합니다.
 */
'use strict';

// ───────── 설정값 / 상수 ─────────
const CONFIG = {
  transitSpeedKmh: 25,      // 대중교통 실제 이동 속도(환승 포함 평균)
  transitOverheadMin: 12,   // 대기·환승 고정 시간
  roadFactor: 1.35,         // 직선거리 → 실제 도로거리 보정
  taxiSpeedKmh: 32,         // 심야 택시 평균 속도
  subwayFare: 1550,         // 지하철 기본요금(교통카드)
  nightBusFare: 2500,       // 심야버스 요금
  jjimFare: 15000,          // 찜질방 예상 비용
  firstTrain: 5 * 60 + 30,  // 첫차 05:30
  nightBusStart: 23 * 60 + 30,
  // 서울 지하철 막차: 평일 최종 도착 ~01:00, 주말·공휴일 ~00:30 기준으로 역산
  cutoffArrival: { weekday: 25 * 60, weekend: 24 * 60 + 30 },
  maxLastDeparture: { weekday: 24 * 60 + 30, weekend: 24 * 60 },
  minLastDeparture: 22 * 60 + 30,
};

const DEFAULTS = { home: null, manualLast: '', walkMin: 8, leadMin: 30, friendPhone: '', party: false };
const STORE_KEY = 'makcha.settings.v1';

// ───────── 상태 ─────────
let settings = loadSettings();
let here = null;          // { lat, lng, manual }
let plan = null;          // 계산 결과
let watchId = null;
let locMsg = '현재 위치를 확인하는 중…';
let wakeLock = null;
let firedAlerts = new Set();
let audioCtx = null;

const $ = (id) => document.getElementById(id);

// ───────── 저장소 ─────────
function loadSettings() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch { return { ...DEFAULTS }; }
}
function saveSettingsToStore() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* 저장 불가 환경 */ }
}

// ───────── 시간 유틸 ─────────
// "운행일" 기준 분: 새벽 5시 이전은 전날 밤의 연장(24시 이후)으로 취급
function nightMinutes(d) {
  let m = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  if (d.getHours() < 5) m += 1440;
  return m;
}
function hhmm(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}
function parseHHMM(s) {
  if (!s) return null;
  const [h, m] = s.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m + (h < 5 ? 1440 : 0);
}
function isWeekendService(d) {
  const service = new Date(d.getTime() - 5 * 3600 * 1000);
  const day = service.getDay();
  return day === 0 || day === 6;
}
function fmtDuration(min) {
  if (min >= 60) {
    const h = Math.floor(min / 60), m = Math.floor(min % 60);
    return `${h}시간 ${String(m).padStart(2, '0')}분`;
  }
  const m = Math.floor(min), s = Math.floor((min - m) * 60);
  return `${m}분 ${String(s).padStart(2, '0')}초`;
}
function won(n) { return (Math.round(n / 10) * 10).toLocaleString('ko-KR') + '원'; }

// ───────── 거리 / 요금 ─────────
function haversineKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// 서울 중형택시 기준: 기본 4,800원(1.6km), 131m당 100원, 저속 30초당 100원
// 심야할증: 22~23시 20%, 23~02시 40%, 02~04시 20%
function taxiFare(roadKm, atNightMin) {
  let fare = 4800;
  if (roadKm > 1.6) fare += Math.ceil(((roadKm - 1.6) * 1000) / 131) * 100;
  const tripMin = (roadKm / CONFIG.taxiSpeedKmh) * 60;
  fare += Math.floor((tripMin * 60 * 0.15) / 30) * 100; // 15%는 저속 구간 가정
  const h = Math.floor((atNightMin % 1440) / 60);
  let surcharge = 0;
  if (h === 22 || h === 2 || h === 3) surcharge = 0.2;
  else if (h === 23 || h === 0 || h === 1) surcharge = 0.4;
  const total = fare * (1 + surcharge);
  const r100 = (n) => Math.round(n / 100) * 100;
  return { low: r100(total * 0.9), high: r100(total * 1.15), mid: r100(total), surcharge, tripMin };
}

// ───────── 핵심 계산 ─────────
function compute() {
  if (!settings.home || !here) return null;
  const now = new Date();
  const nowMin = nightMinutes(now);
  const weekend = isWeekendService(now);
  const distKm = haversineKm(here, settings.home);
  const roadKm = Math.max(distKm * CONFIG.roadFactor, 0.3);
  const transitMin = CONFIG.transitOverheadMin + (roadKm / CONFIG.transitSpeedKmh) * 60;
  const walk = Number(settings.walkMin) || 0;

  const manual = parseHHMM(settings.manualLast);
  let lastDep, source;
  if (manual != null) {
    lastDep = manual; source = '직접 입력한 막차 시각';
  } else {
    const key = weekend ? 'weekend' : 'weekday';
    lastDep = CONFIG.cutoffArrival[key] - transitMin;
    lastDep = Math.min(lastDep, CONFIG.maxLastDeparture[key]);
    lastDep = Math.max(lastDep, CONFIG.minLastDeparture);
    source = `자동 추정·${weekend ? '주말/공휴일' : '평일'}`;
  }
  const leaveBy = lastDep - walk;
  const arrive = lastDep + transitMin;
  const remaining = leaveBy - nowMin;

  // 놓쳤을 때 택시: 지금 또는 막차 이후 출발 가정
  const taxiAt = Math.max(nowMin, leaveBy);
  const taxi = taxiFare(roadKm, taxiAt);

  const alts = buildAlternatives({ nowMin, leaveBy, lastDep, arrive, transitMin, roadKm, taxi, walk });

  return { nowMin, weekend, distKm, roadKm, transitMin, lastDep, leaveBy, arrive, remaining, source, taxi, alts };
}

function buildAlternatives(p) {
  const { nowMin, leaveBy, arrive, transitMin, roadKm, taxi, walk } = p;
  const list = [];

  // 1. 대중교통 막차
  list.push({
    name: '🚇 지하철·버스 막차',
    cost: CONFIG.subwayFare,
    ok: nowMin <= leaveBy,
    desc: nowMin <= leaveBy
      ? `${hhmm(leaveBy)}까지 출발 → 집 도착 약 ${hhmm(arrive)}`
      : `이미 지났어요 (${hhmm(leaveBy)} 출발 필요했음)`,
  });

  // 2. 막차 중간까지 + 택시
  const halfTaxi = taxiFare(roadKm * 0.5, Math.max(nowMin, leaveBy + 30));
  const partialOk = nowMin <= leaveBy + 25;
  list.push({
    name: '🚇+🚕 갈 수 있는 데까지 + 택시',
    cost: CONFIG.subwayFare + halfTaxi.mid,
    ok: partialOk,
    desc: partialOk
      ? `집 방향 남은 열차로 중간까지 이동 후 택시 (택시 구간 약 ${(roadKm * 0.5).toFixed(1)}km)`
      : '중간까지 가는 열차도 끊겼을 가능성이 커요',
  });

  // 3. 심야버스
  const nbOk = roadKm <= 45;
  const nbStart = Math.max(nowMin, CONFIG.nightBusStart);
  const nbMin = transitMin * 1.4 + 20;
  list.push({
    name: '🚌 심야버스 (N버스)',
    cost: CONFIG.nightBusFare,
    ok: nbOk,
    desc: nbOk
      ? `${hhmm(nbStart)} 이후 운행 · 약 ${Math.round(nbMin)}분 소요 (노선 유무는 카카오맵 확인)`
      : '거리가 멀어 심야버스로 가기 어려워요',
  });

  // 4. 택시
  list.push({
    name: '🚕 택시',
    cost: taxi.mid,
    ok: true,
    desc: `약 ${Math.round(taxi.tripMin)}분 · ${roadKm.toFixed(1)}km${taxi.surcharge ? ` · 심야할증 ${Math.round(taxi.surcharge * 100)}%` : ''}`,
  });

  // 5. 첫차
  const firstArrive = 1440 + CONFIG.firstTrain + walk + transitMin;
  list.push({
    name: '🌅 첫차 기다리기',
    cost: CONFIG.subwayFare + CONFIG.jjimFare,
    ok: true,
    desc: `05:30 첫차 → 집 도착 약 ${hhmm(firstArrive)} (찜질방 비용 포함)`,
  });

  // 가능한 것 중 가장 저렴한 것 추천
  const avail = list.filter((r) => r.ok);
  const best = avail.reduce((a, b) => (b.cost < a.cost ? b : a), avail[0]);
  if (best) best.best = true;
  return list;
}

// ───────── 화면 갱신 ─────────
function render() {
  const now = new Date();
  $('clock').textContent = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) +
    (isWeekendService(now) ? ' · 주말/공휴일 시간표' : ' · 평일 시간표');

  $('setupHint').hidden = !!settings.home;
  plan = compute();
  const hero = $('heroCard');

  if (!settings.home) {
    hero.className = 'card hero';
    $('countdown').textContent = '--';
    $('leaveBy').textContent = '집 위치를 먼저 설정해 주세요';
    $('routeMeta').textContent = '';
    $('taxiFare').textContent = '-';
    $('taxiDetail').textContent = '';
    $('altRoutes').innerHTML = '';
    return;
  }
  if (!here) {
    hero.className = 'card hero';
    $('countdown').textContent = '--';
    $('leaveBy').textContent = locMsg;
    return;
  }

  const p = plan;
  const lead = Number(settings.leadMin) || 30;
  let state = 'ok';
  if (p.remaining <= 0) state = 'missed';
  else if (p.remaining <= 10) state = 'urgent';
  else if (p.remaining <= lead) state = 'soon';
  hero.className = 'card hero ' + state;

  if (state === 'missed') {
    $('countdown').textContent = '막차 놓침 😢';
    $('leaveBy').textContent = `${hhmm(p.leaveBy)}에 출발했어야 해요. 아래 대체 경로를 확인하세요.`;
  } else {
    $('countdown').textContent = fmtDuration(p.remaining);
    $('leaveBy').textContent = `${hhmm(p.leaveBy)}까지 출발 → 집 도착 약 ${hhmm(p.arrive)}`;
  }
  $('barFill').style.width = Math.max(0, Math.min(100, (p.remaining / 180) * 100)) + '%';
  $('routeMeta').textContent =
    `집까지 직선 ${p.distKm.toFixed(1)}km · 대중교통 약 ${Math.round(p.transitMin)}분 · 막차 ${hhmm(p.lastDep)} (${p.source}) · 도보 ${settings.walkMin}분`;

  $('taxiFare').textContent = `${won(p.taxi.low)} ~ ${won(p.taxi.high)}`;
  $('taxiDetail').textContent =
    `${p.remaining > 0 ? hhmm(p.leaveBy) + ' 이후' : '지금'} 출발 기준 · 약 ${p.roadKm.toFixed(1)}km, ${Math.round(p.taxi.tripMin)}분` +
    (p.taxi.surcharge ? ` · 심야할증 ${Math.round(p.taxi.surcharge * 100)}% 포함` : '') +
    ' · 시계외(서울 밖) 할증 미포함';

  $('altRoutes').innerHTML = p.alts.map((r) => `
    <li class="${r.ok ? '' : 'off'}">
      <span class="r-name">${r.name}${r.best ? '<span class="tag">추천</span>' : ''}</span>
      <span class="r-cost">${won(r.cost)}</span>
      <span class="r-desc">${r.desc}</span>
    </li>`).join('');

  const name = encodeURIComponent('집');
  $('kakaoRoute').href =
    `https://map.kakao.com/link/from/${encodeURIComponent('현재위치')},${here.lat},${here.lng}/to/${name},${settings.home.lat},${settings.home.lng}`;

  updateSmsLink();
  checkAlerts();
}

// ───────── 위치 ─────────
function setHere(lat, lng, manual = false) {
  here = { lat, lng, manual };
  updateMainMap();
  render();
}

function locate() {
  if (!('geolocation' in navigator)) {
    locMsg = '이 브라우저는 위치 기능을 지원하지 않아요. 맨 아래 지도를 눌러 현재 위치를 지정하세요.';
    render();
    return;
  }
  locMsg = '현재 위치를 확인하는 중…';
  navigator.geolocation.getCurrentPosition(
    (pos) => setHere(pos.coords.latitude, pos.coords.longitude),
    (err) => {
      locMsg = err.code === 1
        ? '위치 권한이 꺼져 있어요. 브라우저에서 위치를 허용하거나, 맨 아래 지도를 눌러 현재 위치를 지정하세요.'
        : '위치를 가져오지 못했어요. 맨 아래 지도를 눌러 현재 위치를 지정하세요.';
      render();
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
  );
}

function startWatch() {
  if (watchId != null || !('geolocation' in navigator)) return;
  watchId = navigator.geolocation.watchPosition(
    (pos) => { if (!here || !here.manual) setHere(pos.coords.latitude, pos.coords.longitude); },
    () => {},
    { enableHighAccuracy: false, maximumAge: 120000 }
  );
}
function stopWatch() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

// ───────── 지도 ─────────
let mainMap, hereMarker, homeMarker, pickMap, pickMarker;
const SEOUL = [37.5665, 126.978];

function tiles() {
  return L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap',
  });
}

function initMaps() {
  if (typeof L === 'undefined') {
    $('map').textContent = '지도를 불러오지 못했어요 (인터넷 연결 확인)';
    return;
  }
  mainMap = L.map('map').setView(SEOUL, 12);
  tiles().addTo(mainMap);
  mainMap.on('click', (e) => setHere(e.latlng.lat, e.latlng.lng, true));
  updateMainMap();
}

function updateMainMap() {
  if (!mainMap) return;
  const pts = [];
  if (here) {
    const ll = [here.lat, here.lng];
    if (!hereMarker) hereMarker = L.circleMarker(ll, { radius: 9, color: '#ffb020', fillOpacity: .9 }).addTo(mainMap).bindTooltip('현재 위치');
    else hereMarker.setLatLng(ll);
    pts.push(ll);
  }
  if (settings.home) {
    const ll = [settings.home.lat, settings.home.lng];
    if (!homeMarker) homeMarker = L.marker(ll).addTo(mainMap).bindTooltip('🏠 집');
    else homeMarker.setLatLng(ll);
    pts.push(ll);
  }
  if (pts.length === 2) mainMap.fitBounds(pts, { padding: [30, 30] });
  else if (pts.length === 1) mainMap.setView(pts[0], 14);
}

function initPickMap() {
  if (typeof L === 'undefined' || pickMap) return;
  pickMap = L.map('pickMap').setView(settings.home ? [settings.home.lat, settings.home.lng] : SEOUL, 13);
  tiles().addTo(pickMap);
  pickMap.on('click', (e) => setDraftHome(e.latlng.lat, e.latlng.lng, '지도에서 선택한 위치'));
}

// ───────── 설정 화면 ─────────
let draftHome = null;

function setDraftHome(lat, lng, label) {
  draftHome = { lat, lng, label };
  $('homeLabel').textContent = '🏠 ' + label;
  if (pickMap) {
    if (!pickMarker) pickMarker = L.marker([lat, lng]).addTo(pickMap);
    else pickMarker.setLatLng([lat, lng]);
    pickMap.setView([lat, lng], 15);
  }
}

function openSettings() {
  draftHome = settings.home;
  $('homeLabel').textContent = settings.home ? '🏠 ' + settings.home.label : '설정 안 됨';
  $('manualLast').value = settings.manualLast;
  $('walkMin').value = settings.walkMin;
  $('leadMin').value = settings.leadMin;
  $('friendPhone').value = settings.friendPhone;
  $('addrResults').innerHTML = '';
  $('settings').showModal();
  initPickMap();
  setTimeout(() => {
    pickMap && pickMap.invalidateSize();
    if (draftHome) setDraftHome(draftHome.lat, draftHome.lng, draftHome.label);
  }, 50);
}

async function searchAddress() {
  const q = $('addrInput').value.trim();
  if (!q) return;
  const ul = $('addrResults');
  ul.innerHTML = '<li>검색 중…</li>';
  try {
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=kr&accept-language=ko&q=' + encodeURIComponent(q);
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const data = await res.json();
    if (!data.length) { ul.innerHTML = '<li>결과가 없어요. 동 이름이나 역 이름으로 검색해 보세요.</li>'; return; }
    ul.innerHTML = '';
    data.forEach((d) => {
      const li = document.createElement('li');
      li.textContent = d.display_name;
      li.onclick = () => {
        const short = d.display_name.split(',').slice(0, 3).join(',');
        setDraftHome(Number(d.lat), Number(d.lon), short);
        ul.innerHTML = '';
      };
      ul.appendChild(li);
    });
  } catch {
    ul.innerHTML = '<li>검색에 실패했어요. 지도를 눌러 지정해 주세요.</li>';
  }
}

function saveSettings() {
  if (draftHome) settings.home = draftHome;
  settings.manualLast = $('manualLast').value;
  settings.walkMin = Math.max(0, Number($('walkMin').value) || 0);
  settings.leadMin = Math.max(5, Number($('leadMin').value) || 30);
  settings.friendPhone = $('friendPhone').value.trim();
  saveSettingsToStore();
  firedAlerts.clear();
  updatePartyDesc();
  updateMainMap();
  render();
}

// ───────── 술자리 모드 / 알림 ─────────
function updatePartyDesc() {
  $('partyDesc').textContent = `켜두면 출발 ${settings.leadMin}분 전, 10분 전, 출발 시각에 알려드려요.`;
}

async function setParty(on) {
  settings.party = on;
  saveSettingsToStore();
  $('partyToggle').checked = on;
  $('partyNote').hidden = !on;
  firedAlerts.clear();
  if (on) {
    if ('Notification' in window && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch { /* 무시 */ }
    }
    unlockAudio();
    await requestWakeLock();
    startWatch();
  } else {
    releaseWakeLock();
    stopWatch();
  }
  render();
}

function checkAlerts() {
  if (!settings.party || !plan) return;
  const lead = Number(settings.leadMin) || 30;
  const marks = [
    { at: lead, title: `막차 출발 ${lead}분 전!`, body: `${hhmm(plan.leaveBy)}까지 출발해야 해요. 슬슬 일어날 준비하세요 🍻` },
    { at: 10, title: '10분 남았어요!', body: `${hhmm(plan.leaveBy)}까지 출발! 지금 계산하고 나가세요 🏃` },
    { at: 0, title: '지금 출발하세요!', body: `놓치면 택시비 약 ${won(plan.taxi.mid)}이에요 🚕` },
  ];
  for (const m of marks) {
    const key = `${Math.round(plan.leaveBy)}@${m.at}`;
    // 해당 시점이 지났고, 출발 시각에서 5분 이상 지나지 않았을 때만 1회 알림
    if (plan.remaining <= m.at && plan.remaining > -5 && !firedAlerts.has(key)) {
      // 이미 더 늦은 단계에 들어와 있다면 이전 단계는 건너뜀
      const later = marks.filter((x) => x.at < m.at && plan.remaining <= x.at);
      firedAlerts.add(key);
      if (later.length) continue;
      fireAlert(m.title, m.body);
    }
  }
}

async function fireAlert(title, body) {
  // 1) 시스템 알림
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      const opts = { body, icon: 'icon.svg', badge: 'icon.svg', tag: 'makcha', renotify: true, vibrate: [300, 150, 300, 150, 600] };
      if (reg) await reg.showNotification(title, opts);
      else new Notification(title, opts);
    } catch { /* 일부 환경에서 실패 가능 */ }
  }
  // 2) 진동 + 소리 + 화면 팝업 (앱이 켜져 있을 때)
  if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 600]);
  beep();
  $('alarmTitle').textContent = title;
  $('alarmBody').textContent = body;
  if (!$('alarm').open) $('alarm').showModal();
}

function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { audioCtx = null; }
}
function beep() {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime;
  [0, 0.35, 0.7].forEach((offset) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'square'; o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, t0 + offset);
    g.gain.exponentialRampToValueAtTime(0.25, t0 + offset + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.25);
    o.connect(g).connect(audioCtx.destination);
    o.start(t0 + offset); o.stop(t0 + offset + 0.3);
  });
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch { wakeLock = null; }
}
function releaseWakeLock() {
  try { wakeLock && wakeLock.release(); } catch { /* 무시 */ }
  wakeLock = null;
}

// ───────── 위치 공유 ─────────
function shareText() {
  if (!here) return null;
  const link = `https://map.kakao.com/link/map/${encodeURIComponent('내 위치')},${here.lat.toFixed(6)},${here.lng.toFixed(6)}`;
  let msg = `[막차알림] 나 지금 여기 있어 📍\n${link}`;
  if (plan) {
    msg += plan.remaining > 0
      ? `\n막차 타려고 ${hhmm(plan.leaveBy)}에 출발할 예정, 집 도착 약 ${hhmm(plan.arrive)}`
      : `\n막차 놓쳐서 다른 방법으로 귀가 중 (택시 약 ${Math.round(plan.taxi.tripMin)}분)`;
  }
  return msg;
}

async function share() {
  const text = shareText();
  const status = $('shareStatus');
  if (!text) { status.textContent = '현재 위치를 먼저 확인해 주세요.'; return; }
  if (navigator.share) {
    try { await navigator.share({ title: '내 위치', text }); status.textContent = '공유했어요.'; return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(text);
    status.textContent = '메시지를 복사했어요. 카톡에 붙여넣기 하세요.';
  } catch {
    status.textContent = text;
  }
}

function updateSmsLink() {
  const text = shareText();
  const phone = (settings.friendPhone || '').replace(/[^0-9+]/g, '');
  $('smsBtn').href = text ? `sms:${phone}?&body=${encodeURIComponent(text)}` : '#';
}

// ───────── 시작 ─────────
function bind() {
  $('openSettings').onclick = openSettings;
  $('setupBtn').onclick = openSettings;
  $('refreshLoc').onclick = () => { if (here) here.manual = false; locate(); };
  $('addrSearch').onclick = searchAddress;
  $('addrInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchAddress(); } });
  $('homeHere').onclick = () => {
    if (here) setDraftHome(here.lat, here.lng, '현재 위치');
    else $('homeLabel').textContent = '현재 위치를 아직 못 가져왔어요';
  };
  $('settings').addEventListener('close', () => {
    if ($('settings').returnValue === 'save') saveSettings();
  });
  $('partyToggle').onchange = (e) => setParty(e.target.checked);
  $('testAlert').onclick = async () => {
    if ('Notification' in window && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch { /* 무시 */ }
    }
    unlockAudio();
    fireAlert('알림 테스트', '막차 알림이 이렇게 울려요 🔔');
  };
  $('alarmOk').onclick = () => $('alarm').close();
  $('shareBtn').onclick = share;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (settings.party) requestWakeLock();
      render();
    }
  });
}

function init() {
  bind();
  initMaps();
  updatePartyDesc();
  if (settings.party) {
    $('partyToggle').checked = true;
    $('partyNote').hidden = false;
    startWatch();
    requestWakeLock();
  }
  locate();
  render();
  setInterval(render, 1000);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
