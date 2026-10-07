// Extrae la sesión del admin desde el Chrome persistente y la guarda en .session.json.
// Uso: node token.mjs [--wait]   (--wait: espera hasta que haya login, revisando cada 5 s)
import { connect, adminPage, readSession, saveSession, decodeJwt } from './lib.mjs';

const wait = process.argv.includes('--wait');
const { browser, context } = await connect();
try {
  for (;;) {
    const page = await adminPage(context);
    const s = await readSession(page);
    if (s.appToken) {
      const p = decodeJwt(s.appToken) ?? {};
      const exp = p.exp ? new Date(p.exp * 1000) : null;
      saveSession({ ...s, savedAt: new Date().toISOString(), appTokenExp: exp?.toISOString() ?? null });
      console.log(`sesión guardada · usuario=${p.username ?? p['cognito:username'] ?? '?'} · iss=${p.iss ?? '?'} · exp=${exp?.toLocaleString() ?? '?'}`);
      break;
    }
    if (!wait) { console.log(`sin sesión aún (pestaña en ${s.url})`); process.exitCode = 2; break; }
    await new Promise((r) => setTimeout(r, 5000));
  }
} finally {
  // Nunca cerramos `browser`: es el Chrome real y compartido con Jovanny — browser.close()
  // lo mataría (y con noDefaults+isLocal, Playwright lo trata como propio). Solo soltamos
  // la conexión CDP dejando que el proceso termine — pero el WebSocket abierto no deja
  // salir a node solo, así que forzamos la salida explícita.
  process.exit(process.exitCode ?? 0);
}
