const GOOGLE_CLIENT_ID = '215287871947-3f5q1t4ioj56bq0hk054jdp63qjq7n97.apps.googleusercontent.com';

const googleButton = document.querySelector('#googleLoginButton');
const userMenu = document.querySelector('#userMenu');
const userPicture = document.querySelector('#userPicture');
const userName = document.querySelector('#userName');
const logoutButton = document.querySelector('#logoutButton');
const authMessage = document.querySelector('#authMessage');

function showAuthMessage(message) {
  authMessage.textContent = message;
  authMessage.hidden = false;
  window.setTimeout(() => { authMessage.hidden = true; }, 5000);
}

function showLoggedOut() {
  userMenu.hidden = true;
  googleButton.hidden = false;
  document.body.classList.remove('authenticated');
  window.dispatchEvent(new CustomEvent('authchange', { detail: { authenticated: false } }));
}

function showLoggedIn(user) {
  googleButton.hidden = true;
  userName.textContent = user.name || user.email || '사용자';
  userPicture.src = user.picture || '';
  userPicture.alt = `${user.name || '사용자'} 프로필 사진`;
  userMenu.hidden = false;
  document.body.classList.add('authenticated');
  window.dispatchEvent(new CustomEvent('authchange', { detail: { authenticated: true, user } }));
}

async function handleGoogleCredential(response) {
  try {
    const result = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ credential: response.credential })
    });
    if (!result.ok) throw new Error();
    showLoggedIn(await result.json());
  } catch {
    showLoggedOut();
    showAuthMessage('Google 로그인에 실패했어요. 잠시 후 다시 시도해 주세요.');
  }
}

async function loadSession() {
  try {
    const response = await fetch('/api/auth/session', {
      credentials: 'same-origin',
      cache: 'no-store'
    });
    if (!response.ok) return showLoggedOut();
    showLoggedIn(await response.json());
  } catch {
    showLoggedOut();
  }
}

async function waitForGoogle() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (window.google?.accounts?.id) return true;
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  return false;
}

async function initializeGoogleLogin() {
  if (!await waitForGoogle()) {
    showAuthMessage('Google 로그인 서비스를 불러오지 못했어요.');
    return;
  }
  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: handleGoogleCredential,
    ux_mode: 'popup',
    auto_select: false
  });
  google.accounts.id.renderButton(googleButton, {
    type: 'standard',
    theme: 'outline',
    size: 'medium',
    shape: 'pill',
    text: 'signin_with',
    logo_alignment: 'left',
    locale: 'ko'
  });
  await loadSession();
}

logoutButton.addEventListener('click', async () => {
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin'
    });
  } finally {
    google.accounts.id.disableAutoSelect();
    showLoggedOut();
  }
});

initializeGoogleLogin();
