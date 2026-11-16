/* 막차알림 — 친구가 보는 실시간 위치 화면 */
'use strict';

const POLL_MS = 10000;
const STALE_MIN = 5; // 5분 넘게 업데이트가 없으면 '신호 끊김'

const $ = (id) => document.getElementById(id);
const shareId = new URLSearchParams(location.search).get('id');
let map, marker, circle, timer, firstFix = true;

async function getShare() {
  const c = window.MAKCHA_CONFIG || {};
  const headers = { 'Content-Type': 'application/json', apikey: c.supabaseKey };
  if (!c.supabaseKey.startsWith('sb_')) headers.Authorization = 'Bearer ' + c.supabaseKey;
  const res = await fetch(c.supabaseUrl.replace(/\/+$/, '') + '/rest/v1/rpc/makcha_get_share', {
    method: 'POST', headers, body: JSON.stringify({ p_id: shareId }),
  });
  if (!res.ok) throw new Error('makcha_get_share ' + res.status);
  const rows = await res.json();
  return rows[0] || null;
}

function minutesAgo(iso) {
  return (Date.now() - new Date(iso).getTime()) / 60000;
}
function agoText(iso) {
  const m = minutesAgo(iso);
  if (m < 1) return '방금 전';
  if (m < 60) return Math.floor(m) + '분 전';
  return new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

function setStatus(text, cls) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status ' + (cls || '');
}

function showOnMap(s) {
  if (s.lat == null || typeof L === 'undefined') return;
  const ll = [s.lat, s.lng];
  if (!map) {
    map = L.map('map').setView(ll, 16);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  }
  if (!marker) marker = L.circleMarker(ll, { radius: 10, color: '#ffb020', fillOpacity: .9 }).addTo(map);
  else marker.setLatLng(ll);
  if (s.accuracy) {
    if (!circle) circle = L.circle(ll, { radius: s.accuracy, color: '#ffb020', weight: 1, fillOpacity: .1 }).addTo(map);
    else circle.setLatLng(ll).setRadius(s.accuracy);
  }
  if (firstFix) { map.setView(ll, 16); firstFix = false; }
  else map.panTo(ll);
  const k = $('kakao');
  k.hidden = false;
  k.href = `https://map.kakao.com/link/map/${encodeURIComponent('친구 위치')},${s.lat},${s.lng}`;
}

async function refresh() {
  try {
    const s = await getShare();
    if (!s) {
      setStatus('공유를 찾을 수 없어요', 'ended');
      $('updated').textContent = '링크가 잘못됐거나 오래돼서 지워진 공유예요.';
      stop();
      return;
    }
    showOnMap(s);
    $('note').textContent = s.note || '';
    $('updated').textContent = '마지막 위치: ' + agoText(s.updated_at);

    if (s.status === 'arrived') {
      setStatus('🏠 집에 도착했어요', 'arrived');
      stop();
    } else if (s.status === 'stopped') {
      setStatus('공유가 끝났어요', 'ended');
      stop();
    } else if (s.status === 'expired') {
      setStatus('공유 시간이 끝났어요', 'ended');
      stop();
    } else if (minutesAgo(s.updated_at) > STALE_MIN) {
      setStatus('⚠️ 신호 끊김', 'stale');
      $('updated').textContent += ' · 친구 폰에서 앱이 꺼졌거나 인터넷이 끊겼을 수 있어요.';
    } else {
      setStatus('🟢 실시간 공유 중', 'live');
    }
  } catch (err) {
    setStatus('⚠️ 불러오기 실패', 'stale');
    $('updated').textContent = '인터넷 연결을 확인해 주세요. 잠시 후 다시 시도해요.';
    console.error(err);
  }
}

function stop() {
  clearInterval(timer);
  timer = null;
}

function init() {
  $('reload').onclick = refresh;
  const c = window.MAKCHA_CONFIG || {};
  if (!c.supabaseUrl || !c.supabaseKey) {
    setStatus('서버 연결 설정이 아직 안 됐어요', 'ended');
    return;
  }
  if (!shareId || !/^[0-9a-f-]{36}$/i.test(shareId)) {
    setStatus('잘못된 링크예요', 'ended');
    $('updated').textContent = '받은 링크 전체를 다시 눌러 주세요.';
    return;
  }
  refresh();
  timer = setInterval(refresh, POLL_MS);
}

init();
