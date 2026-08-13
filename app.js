const $ = (selector) => document.querySelector(selector);
const form = $('#searchForm');
const input = $('#locationInput');
const suggestions = $('#suggestions');
const weatherPanel = $('#weatherPanel');
const emptyState = $('#emptyState');
const statusBox = $('#status');
const statusText = $('#statusText');
const clearButton = $('#clearButton');
const unitToggle = $('#unitToggle');
const mapPanel = $('#mapPanel');

let selectedPlace = null;
let currentUnit = 'celsius';
let lastCoordinates = null;
let searchTimer;
let mapInstance = null;
let mapMarker = null;

const weatherCodes = {
  0: ['맑음', '☀'], 1: ['대체로 맑음', '◐'], 2: ['부분적으로 흐림', '⛅'], 3: ['흐림', '☁'],
  45: ['안개', '≋'], 48: ['서리 안개', '≋'], 51: ['약한 이슬비', '☂'], 53: ['이슬비', '☂'], 55: ['강한 이슬비', '☂'],
  56: ['어는 이슬비', '❄'], 57: ['강한 어는 이슬비', '❄'], 61: ['약한 비', '☂'], 63: ['비', '☂'], 65: ['강한 비', '☂'],
  66: ['어는 비', '❄'], 67: ['강한 어는 비', '❄'], 71: ['약한 눈', '❄'], 73: ['눈', '❄'], 75: ['강한 눈', '❄'],
  77: ['싸락눈', '❄'], 80: ['약한 소나기', '☔'], 81: ['소나기', '☔'], 82: ['강한 소나기', '☔'],
  85: ['눈 소나기', '❄'], 86: ['강한 눈 소나기', '❄'], 95: ['뇌우', 'ϟ'], 96: ['우박을 동반한 뇌우', 'ϟ'], 99: ['강한 우박과 뇌우', 'ϟ']
};

function setLoading(message = '날씨를 불러오는 중이에요') {
  weatherPanel.hidden = true;
  emptyState.hidden = true;
  statusBox.hidden = false;
  statusText.textContent = message;
  statusBox.querySelector('.loader').hidden = false;
}

function showError(message) {
  weatherPanel.hidden = true;
  emptyState.hidden = true;
  statusBox.hidden = false;
  statusBox.querySelector('.loader').hidden = true;
  statusText.textContent = message;
}

function placeLabel(place) {
  return [place.name, place.admin1, place.country].filter((v, i, a) => v && a.indexOf(v) === i).join(', ');
}

const koreanRegionAliases = {
  서울: '서울특별시', 서울시: '서울특별시',
  부산: '부산광역시', 부산시: '부산광역시',
  대구: '대구광역시', 대구시: '대구광역시',
  인천: '인천광역시', 인천시: '인천광역시',
  광주: '광주광역시', 광주시: '광주광역시',
  대전: '대전광역시', 대전시: '대전광역시',
  울산: '울산광역시', 울산시: '울산광역시',
  세종: '세종특별자치시', 세종시: '세종특별자치시',
  경기: '경기도', 강원: '강원특별자치도', 충북: '충청북도', 충남: '충청남도',
  전북: '전북특별자치도', 전남: '전라남도', 경북: '경상북도', 경남: '경상남도',
  제주: '제주특별자치도', 제주도: '제주특별자치도'
};

function buildSearchVariants(rawQuery) {
  const query = rawQuery.trim().replace(/\s+/g, ' ');
  const compact = query.replace(/\s/g, '');
  const variants = [koreanRegionAliases[compact], query];

  // "서울시", "수원시", "해운대구"처럼 일상적으로 붙이는 행정구역
  // 접미사를 제거한 이름도 함께 조회한다.
  const withoutSuffix = query.replace(/(특별자치도|특별자치시|특별시|광역시|자치구|시|군|구|도)$/u, '').trim();
  if (withoutSuffix && withoutSuffix !== query) variants.push(withoutSuffix);

  return [...new Set(variants.filter(Boolean))].slice(0, 3);
}

async function searchPlaces(query) {
  const requests = buildSearchVariants(query).map(async (name) => {
    const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
    url.search = new URLSearchParams({ name, count: '20', language: 'ko', format: 'json' });
    const response = await fetch(url);
    if (!response.ok) throw new Error('지역 검색에 실패했습니다.');
    return (await response.json()).results || [];
  });

  const groups = await Promise.all(requests);
  const seen = new Set();
  const results = groups.flat().filter((place) => {
    const key = place.id || `${place.latitude},${place.longitude}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 대한민국을 우선으로 정렬
  return results.sort((a, b) => {
    const aIsKorea = a.country === '대한민국' ? 0 : 1;
    const bIsKorea = b.country === '대한민국' ? 0 : 1;
    return aIsKorea - bIsKorea;
  }).slice(0, 15);
}

function renderSuggestions(places) {
  suggestions.innerHTML = '';
  if (!places.length) {
    suggestions.innerHTML = '<li><button type="button" disabled><span>검색 결과가 없습니다.</span></button></li>';
  } else {
    places.forEach((place) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'option');
      button.innerHTML = `<span>${place.name}</span><small>${[place.admin1, place.country].filter(Boolean).join(' · ')}</small>`;
      button.addEventListener('click', () => selectPlace(place));
      item.appendChild(button);
      suggestions.appendChild(item);
    });
  }
  suggestions.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

function selectPlace(place) {
  selectedPlace = place;
  input.value = placeLabel(place);
  clearButton.hidden = false;
  closeSuggestions();
  loadWeather(place.latitude, place.longitude, place);
}

function closeSuggestions() {
  suggestions.hidden = true;
  input.setAttribute('aria-expanded', 'false');
}

async function loadWeather(latitude, longitude, place) {
  setLoading();
  lastCoordinates = { latitude, longitude, place };
  try {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.search = new URLSearchParams({
      latitude, longitude,
      current: 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m',
      daily: 'temperature_2m_max,temperature_2m_min',
      temperature_unit: currentUnit === 'fahrenheit' ? 'fahrenheit' : 'celsius',
      wind_speed_unit: 'kmh', timezone: 'auto', forecast_days: '1'
    });
    const response = await fetch(url);
    if (!response.ok) throw new Error();
    renderWeather(await response.json(), place);
    saveRecent(place);
  } catch {
    showError('날씨 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.');
  }
}

function renderWeather(data, place) {
  const current = data.current;
  const [condition, symbol] = weatherCodes[current.weather_code] || ['알 수 없음', '○'];
  $('#placeName').textContent = place.name || '현재 위치';
  $('#localTime').textContent = [place.admin1, place.country].filter(Boolean).join(' · ') || data.timezone;
  $('#temperature').textContent = Math.round(current.temperature_2m);
  $('#temperatureUnit').textContent = currentUnit === 'celsius' ? '°C' : '°F';
  $('#condition').textContent = condition;
  $('#weatherSymbol').textContent = symbol;
  $('#feelsLike').textContent = `체감 온도 ${Math.round(current.apparent_temperature)}°`;
  $('#windSpeed').textContent = `${Math.round(current.wind_speed_10m)} km/h`;
  $('#humidity').textContent = `${current.relative_humidity_2m}%`;
  $('#precipitation').textContent = `${current.precipitation} mm`;
  $('#highLow').textContent = `${Math.round(data.daily.temperature_2m_max[0])}° / ${Math.round(data.daily.temperature_2m_min[0])}°`;
  statusBox.hidden = true;
  emptyState.hidden = true;
  weatherPanel.hidden = false;
  showLocationOnMap(lastCoordinates.latitude, lastCoordinates.longitude, place);
}

function showLocationOnMap(latitude, longitude, place) {
  mapPanel.hidden = false;
  $('#mapPlaceName').textContent = placeLabel(place) || place.name || '선택한 위치';
  $('#mapCoordinates').textContent = `${Number(latitude).toFixed(4)}° · ${Number(longitude).toFixed(4)}°`;

  if (!mapInstance) {
    mapInstance = L.map('map', { zoomControl: false, worldCopyJump: true }).setView([latitude, longitude], 9);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(mapInstance);
    L.control.zoom({ position: 'topright' }).addTo(mapInstance);
  }

  if (mapMarker) mapMarker.remove();
  const markerIcon = L.divIcon({ className: 'weather-map-marker', html: '<span></span>', iconSize: [30, 38], iconAnchor: [15, 38] });
  mapMarker = L.marker([latitude, longitude], { icon: markerIcon, title: place.name || '선택한 위치' }).addTo(mapInstance);
  mapInstance.setView([latitude, longitude], 9, { animate: true });
  window.setTimeout(() => mapInstance.invalidateSize(), 80);
}

$('#mapReset').addEventListener('click', () => {
  if (!mapInstance || !lastCoordinates) return;
  mapInstance.flyTo([lastCoordinates.latitude, lastCoordinates.longitude], 9, { duration: 1.1 });
});

function saveRecent(place) {
  if (!place.name || place.name === '현재 위치') return;
  const recent = JSON.parse(localStorage.getItem('weatherRecent') || '[]');
  const next = [place, ...recent.filter((item) => item.name !== place.name || item.country !== place.country)].slice(0, 3);
  localStorage.setItem('weatherRecent', JSON.stringify(next));
  renderRecent();
}

function renderRecent() {
  const recent = JSON.parse(localStorage.getItem('weatherRecent') || '[]');
  const holder = $('#recentButtons');
  holder.innerHTML = '';
  $('#recentSearches').hidden = recent.length === 0;
  recent.forEach((place) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = place.name;
    button.addEventListener('click', () => selectPlace(place));
    holder.appendChild(button);
  });
}

input.addEventListener('input', () => {
  selectedPlace = null;
  clearButton.hidden = !input.value;
  clearTimeout(searchTimer);
  const query = input.value.trim();
  if (query.length < 2) return closeSuggestions();
  searchTimer = setTimeout(async () => {
    try { renderSuggestions(await searchPlaces(query)); }
    catch { closeSuggestions(); }
  }, 320);
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = input.value.trim();
  if (!query) return input.focus();
  if (selectedPlace) return loadWeather(selectedPlace.latitude, selectedPlace.longitude, selectedPlace);
  setLoading('지역을 찾고 있어요');
  closeSuggestions();
  try {
    const places = await searchPlaces(query);
    if (!places.length) return showError('검색한 지역을 찾지 못했어요. 도시 이름을 다시 확인해 주세요.');
    selectPlace(places[0]);
  } catch { showError('지역 검색에 실패했어요. 인터넷 연결을 확인해 주세요.'); }
});

clearButton.addEventListener('click', () => {
  input.value = '';
  selectedPlace = null;
  clearButton.hidden = true;
  closeSuggestions();
  input.focus();
});

$('#locationButton').addEventListener('click', () => {
  if (!navigator.geolocation) return showError('이 브라우저에서는 위치 기능을 지원하지 않아요.');
  setLoading('현재 위치를 확인하고 있어요');
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => loadWeather(coords.latitude, coords.longitude, { name: '현재 위치' }),
    () => showError('위치 권한을 허용하지 않았거나 현재 위치를 확인할 수 없어요.'),
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

unitToggle.addEventListener('click', () => {
  currentUnit = currentUnit === 'celsius' ? 'fahrenheit' : 'celsius';
  const labels = unitToggle.querySelectorAll('span');
  labels[0].classList.toggle('active', currentUnit === 'celsius');
  labels[1].classList.toggle('active', currentUnit === 'fahrenheit');
  if (lastCoordinates) loadWeather(lastCoordinates.latitude, lastCoordinates.longitude, lastCoordinates.place);
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('.search-area')) closeSuggestions();
});

input.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeSuggestions();
  if (event.key === 'ArrowDown' && !suggestions.hidden) {
    event.preventDefault();
    suggestions.querySelector('button:not([disabled])')?.focus();
  }
});

$('#todayDate').textContent = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }).format(new Date());
renderRecent();
