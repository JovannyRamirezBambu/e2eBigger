// Guarda la sesión del admin leyéndola del PORTAPAPELES, sin Chrome instrumentado ni CDP.
//
// Para cuando la sesión vive en otro navegador (Brave, el Chrome personal) que no escucha en el
// puerto de depuración. El token no pasa por la conversación: va del navegador al portapapeles y
// de ahí a .session.json.
//
// 1) En la consola del navegador, con el admin abierto:
//      copy(JSON.stringify({accessToken:sessionStorage.getItem('er-tkn'),refreshToken:sessionStorage.getItem('er-tkn-r'),appToken:sessionStorage.getItem('er-tkn-a'),user:sessionStorage.getItem('er-user')}))
// 2) En la terminal:
//      pbpaste | node token-paste.mjs
import fs from 'node:fs';
import { SESSION_FILE, decodeJwt } from './lib.mjs';

const crudo = fs.readFileSync(0, 'utf8').trim();
if (!crudo) {
  console.error('El portapapeles venía vacío. Corre el copy(...) en la consola del navegador primero.');
  process.exit(2);
}

let sesion;
try {
  sesion = JSON.parse(crudo);
} catch {
  // Por si pegaron solo el token suelto en vez del JSON completo.
  sesion = crudo.split('.').length === 3 ? { appToken: crudo } : null;
  if (!sesion) {
    console.error('Esto no es ni el JSON del copy(...) ni un JWT suelto.');
    process.exit(2);
  }
}

if (!sesion.appToken) {
  console.error('Falta appToken (er-tkn-a) — es el que usa el relay de BIGER.');
  process.exit(2);
}

const payload = decodeJwt(sesion.appToken) ?? {};
const exp = payload.exp ? new Date(payload.exp * 1000) : null;
if (exp && exp < new Date()) {
  console.error(`Ese appToken ya expiró (${exp.toLocaleString()}). Vuelve a copiarlo con la sesión fresca.`);
  process.exit(2);
}

fs.writeFileSync(
  SESSION_FILE,
  JSON.stringify({ ...sesion, savedAt: new Date().toISOString(), appTokenExp: exp?.toISOString() ?? null }, null, 2),
);
console.log(
  `sesión guardada · usuario=${payload.username ?? payload['cognito:username'] ?? '?'} · exp=${exp?.toLocaleString() ?? '?'}` +
    (sesion.accessToken ? '' : '\n  (sin accessToken: el --check contra BCB no podrá consultar la fuente)'),
);
