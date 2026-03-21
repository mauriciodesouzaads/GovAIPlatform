const TOKEN_KEY = 'govai_admin_token';

function safeStorage(kind: 'sessionStorage' | 'localStorage'): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window[kind];
  } catch {
    return null;
  }
}

export function getAuthToken(): string | null {
  const session = safeStorage('sessionStorage');
  const local = safeStorage('localStorage');
  return session?.getItem(TOKEN_KEY) || local?.getItem(TOKEN_KEY) || null;
}

export function setAuthToken(token: string): void {
  const session = safeStorage('sessionStorage');
  const local = safeStorage('localStorage');
  session?.setItem(TOKEN_KEY, token);
  local?.removeItem(TOKEN_KEY);
}

export function clearAuthToken(): void {
  safeStorage('sessionStorage')?.removeItem(TOKEN_KEY);
  safeStorage('localStorage')?.removeItem(TOKEN_KEY);
}

export { TOKEN_KEY };
