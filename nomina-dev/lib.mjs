// Helpers compartidos: conexión al Chrome persistente (CDP) y sesión del admin.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CDP_URL = process.env.NOMINA_CHROME_CDP ?? 'http://127.0.0.1:9222';
export const ADMIN_URL = process.env.NOMINA_ADMIN_URL ?? 'http://127.0.0.1:4200';
export const RELAY_URL = process.env.NOMINA_RELAY_URL ?? 'https://devbiger.desarrollobambu.com/portalnomina';
export const SESSION_FILE = path.join(HERE, '.session.json');
export const KEYS = { access: 'er-tkn', refresh: 'er-tkn-r', app: 'er-tkn-a', user: 'er-user' };

export async function connect() {
  // noDefaults: true evita que Playwright intente Browser.setDownloadBehavior sin
  // browserContextId al inicializar el "contexto por defecto" — esta versión de Chrome
  // ya no lo acepta y la conexión fallaba con "Browser context management is not supported".
  // isLocal: true es necesario junto con noDefaults para que igual descubra las pestañas
  // que ya estaban abiertas (sin él, context.pages() queda vacío aunque haya pestañas reales).
  // timeout más generoso: tras muchas conexiones/desconexiones seguidas en la misma sesión de
  // Chrome, el handshake del endpoint CDP a nivel navegador se ha visto tardar >30s (no está
  // colgado, solo lento) — nunca lo vimos fallar con 60s.
  const browser = await chromium.connectOverCDP(CDP_URL, { noDefaults: true, isLocal: true, timeout: 60000 });
  const context = browser.contexts()[0];
  if (!context) throw new Error('Chrome sin contexto por defecto');
  return { browser, context };
}

/** La pestaña del admin (la primera que apunte a ADMIN_URL), o una nueva. */
export async function adminPage(context, { create = false } = {}) {
  const pages = context.pages().filter((p) => p.url().startsWith(ADMIN_URL));
  if (pages.length && !create) return pages[0];
  const page = await context.newPage();
  await page.goto(ADMIN_URL + '/');
  return page;
}

/** Lee la sesión (sessionStorage) de la pestaña del admin. */
export async function readSession(page) {
  return page.evaluate((KEYS) => {
    const get = (k) => sessionStorage.getItem(k);
    return {
      accessToken: get(KEYS.access), refreshToken: get(KEYS.refresh),
      appToken: get(KEYS.app), user: get(KEYS.user), url: location.href,
    };
  }, KEYS);
}

export function decodeJwt(token) {
  try {
    const [, p] = token.split('.');
    return JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch { return null; }
}

export function loadSession() {
  if (!fs.existsSync(SESSION_FILE)) return null;
  return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
}

export function saveSession(s) {
  fs.writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2));
}

/** Inyecta la sesión guardada en una pestaña nueva (evita re-login en pruebas automáticas). */
export async function newAuthedPage(context, session) {
  const page = await context.newPage();
  await page.addInitScript(({ s, KEYS }) => {
    if (s.accessToken) sessionStorage.setItem(KEYS.access, s.accessToken);
    if (s.refreshToken) sessionStorage.setItem(KEYS.refresh, s.refreshToken);
    if (s.appToken) sessionStorage.setItem(KEYS.app, s.appToken);
    if (s.user) sessionStorage.setItem(KEYS.user, s.user);
  }, { s: session, KEYS });
  return page;
}
