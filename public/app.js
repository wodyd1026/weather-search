const $ = (selector) => document.querySelector(selector);
const form = $('#searchForm');
const input = $('#locationInput');
const suggestions = $('#suggestions');
const weatherPanel = $('#weatherPanel');
const emptyState = $('#emptyState');
const statusBox = $('#status');
const statusText = $('#statusText');
const clearButton = $('#clearButton');
const mapPanel = $('#mapPanel');

let selectedPlace = null;
let lastCoordinates = null;
let searchTimer;
let mapInstance = null;
let mapMarker = null;
let isAuthenticated = false;

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
  return [place.name, place.admin2, place.admin1, place.country].filter((v, i, a) => v && a.indexOf(v) === i).join(', ');
}

async function searchPlaces(query) {
  // 한글 지역 검색은 대한민국 정부의 공식 법정동 코드에서 추출한
  // 시·도 및 시·군·구 목록만 사용한다. 해외 지오코더 결과를 섞지 않는다.
  if (/[가-힣]/u.test(query)) return searchOfficialKoreanRegions(query);

  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  url.search = new URLSearchParams({ name: query.trim(), count: '15', language: 'ko', format: 'json' });
  const response = await fetch(url);
  if (!response.ok) throw new Error('지역 검색에 실패했습니다.');
  return ((await response.json()).results || []).map((place) => ({ ...place, searchSource: 'open-meteo' }));
}

function officialSearchKey(value = '') {
  return value.toLowerCase().replace(/\s/g, '');
}

function officialCoreKey(value = '') {
  return value.toLowerCase().trim().split(/\s+/)
    .map((part) => part.replace(/(특별자치도|특별자치시|특별시|광역시|자치구|시|군|구|도)$/u, ''))
    .join('');
}

function searchOfficialKoreanRegions(rawQuery) {
  const query = officialSearchKey(rawQuery);
  const queryCore = officialCoreKey(rawQuery);
  if (!query) return [];

  return OFFICIAL_KOREAN_REGIONS
    .map((region) => {
      const nameKey = officialSearchKey(region.name);
      const fullKey = officialSearchKey(`${region.sido} ${region.name}`);
      const nameCore = officialCoreKey(region.name);
      const fullCore = officialCoreKey(`${region.sido} ${region.name}`);
      let score = 0;
      if (nameKey === query) score = 600;
      else if (nameCore === queryCore) score = 550;
      else if (fullKey === query) score = 540;
      else if (fullCore === queryCore) score = 520;
      else if (nameKey.startsWith(query)) score = 350;
      return { region, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.region.level - b.region.level || a.region.name.localeCompare(b.region.name, 'ko'))
    .slice(0, 15)
    .map(({ region }) => ({
      id: `kr-${region.code}`,
      officialCode: region.code,
      officialRegion: true,
      name: region.name,
      admin1: region.level === 2 ? region.sido : undefined,
      country: '대한민국',
      country_code: 'KR',
      feature_code: 'ADM',
      searchSource: 'official-korean-code'
    }));
}

function normalizeKoreanName(value = '') {
  return value.replace(/\s/g, '').replace(/(특별자치도|특별자치시|특별시|광역시|자치구|시|군|구|도)$/u, '');
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
      button.innerHTML = `<span>${place.name}</span><small>${[place.admin1, place.admin2, place.country].filter((v, i, a) => v && v !== place.name && a.indexOf(v) === i).join(' · ')}</small>`;
      button.addEventListener('click', () => selectPlace(place));
      item.appendChild(button);
      suggestions.appendChild(item);
    });
  }
  suggestions.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

async function selectPlace(place) {
  selectedPlace = place;
  input.value = placeLabel(place);
  clearButton.hidden = false;
  closeSuggestions();
  if (place.officialRegion && (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude))) {
    setLoading('공식 행정구역의 위치를 확인하고 있어요');
    const coordinates = await resolveOfficialRegionCoordinates(place);
    if (!coordinates) {
      showError('공식 행정구역은 확인했지만 지도 좌표를 찾지 못했어요. 다른 지역을 선택해 주세요.');
      return;
    }
    Object.assign(place, coordinates);
  }
  loadWeather(place.latitude, place.longitude, place);
}

async function resolveOfficialRegionCoordinates(place) {
  const fullName = [place.admin1, place.name, '대한민국'].filter(Boolean).join(' ');
  const url = new URL('https://photon.komoot.io/api/');
  url.search = new URLSearchParams({ q: fullName, limit: '12' });
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    const expectedName = normalizeKoreanName(place.name.split(/\s+/).at(-1));
    const expectedSido = normalizeKoreanName(place.admin1 || place.name);
    const match = (data.features || []).find(({ properties }) => {
      const adminLevel = Number(properties.extra?.admin_level);
      const candidateSido = normalizeKoreanName(properties.state || properties.city || properties.name);
      return properties.countrycode === 'KR'
        && [4, 6].includes(adminLevel)
        && ['place', 'boundary'].includes(properties.osm_key)
        && normalizeKoreanName(properties.name) === expectedName
        && (place.admin1 ? candidateSido === expectedSido : true);
    });
    if (!match) return null;
    return { latitude: match.geometry.coordinates[1], longitude: match.geometry.coordinates[0] };
  } catch {
    return null;
  }
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
      temperature_unit: 'celsius',
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
  $('#temperatureUnit').textContent = '°C';
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
  const storedRecent = JSON.parse(localStorage.getItem('weatherRecent') || '[]');
  const recent = storedRecent.filter((place) => {
    if (place.country_code === 'KR' || place.country === '대한민국') {
      const officialMatch = OFFICIAL_KOREAN_REGIONS.some((region) =>
        (place.officialCode && region.code === place.officialCode)
        || (normalizeKoreanName(region.name) === normalizeKoreanName(place.name)
          && (region.level === 1 || region.sido === place.admin1)));
      if (!officialMatch) return false;
    }
    return true;
  });
  if (recent.length !== storedRecent.length) {
    localStorage.setItem('weatherRecent', JSON.stringify(recent));
  }
  const holder = $('#recentButtons');
  holder.innerHTML = '';
  $('#recentSearches').hidden = recent.length === 0;
  recent.forEach((place) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = place.name;
    button.disabled = !isAuthenticated;
    button.addEventListener('click', () => selectPlace(place));
    holder.appendChild(button);
  });
}

function applyAuthenticationState(authenticated) {
  isAuthenticated = authenticated;
  input.disabled = !authenticated;
  form.querySelector('.search-button').disabled = !authenticated;
  $('#locationButton').disabled = !authenticated;
  input.placeholder = authenticated ? '도시 또는 지역을 검색하세요' : '로그인 후 지역을 검색하세요';
  closeSuggestions();

  if (!authenticated) {
    input.value = '';
    selectedPlace = null;
    clearButton.hidden = true;
    weatherPanel.hidden = true;
    mapPanel.hidden = true;
    statusBox.hidden = true;
    emptyState.hidden = false;
  }
  renderRecent();
}

window.addEventListener('authchange', (event) => {
  applyAuthenticationState(Boolean(event.detail?.authenticated));
});

input.addEventListener('input', () => {
  if (!isAuthenticated) return;
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
  if (!isAuthenticated) return;
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
  if (!isAuthenticated) return;
  if (!navigator.geolocation) return showError('이 브라우저에서는 위치 기능을 지원하지 않아요.');
  setLoading('현재 위치를 확인하고 있어요');
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => loadWeather(coords.latitude, coords.longitude, { name: '현재 위치' }),
    () => showError('위치 권한을 허용하지 않았거나 현재 위치를 확인할 수 없어요.'),
    { enableHighAccuracy: true, timeout: 10000 }
  );
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
