#!/usr/bin/env node
/**
 * Servidor JWKS mínimo, sin dependencias. Publica UNA llave pública RSA en el
 * formato que espera Nimbus (el validador de Spring Security).
 *
 *   node lib/jwks-server.js <public.pem> <puerto> <ruta-base>
 *
 * ¿Por qué hace falta? El flujo ticketcolectoroffline no se puede probar con
 * `JWT_BYPASS=true`. Sus dos controllers llevan `@BcbAuth({ADVISOR})`, y la
 * identidad del taquillero NO viaja en el payload: sale del SecurityContext que
 * deja el autenticador BCB multi-emisor, viaja en el `_auth` del mensaje NATS y
 * termina como los claims `userId`/`role` del JWT que adapter-bcb le firma a BCB.
 * Con el bypass ese SecurityContext queda vacío → `_auth` vacío → el token
 * saliente no lleva userId/role → el ContratoTokenGuard de BCB responde 401.
 *
 * Es decir: sin un emisor JWKS de verdad, el flujo no se puede probar de punta a
 * punta, y la cadena de identidad —que es justo lo único que este flujo tiene de
 * particular— quedaría sin cubrir.
 *
 * El `kid` se deriva del thumbprint RFC 7638 de la llave, no es una constante.
 * Nimbus cachea el JWKS por kid: con un kid fijo, regenerar run/keys/ dejaría al
 * adapter validando contra la llave vieja y daría un 401 sin explicación. Con el
 * thumbprint, una llave nueva trae kid nuevo, Nimbus no lo encuentra en su caché
 * y vuelve a bajar el JWKS.
 */
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

const [, , keyPath, portArg, basePathArg] = process.argv;
if (!keyPath || !portArg) {
  console.error('uso: jwks-server.js <public.pem> <puerto> [ruta-base]');
  process.exit(1);
}
const PORT = Number(portArg);
const BASE = (basePathArg || '/advisor').replace(/\/$/, '');

/** Thumbprint RFC 7638: SHA-256 del JSON canónico {e,kty,n} (llaves ordenadas). */
function thumbprint(jwk) {
  const canonical = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
  return crypto.createHash('sha256').update(canonical).digest('base64url');
}

function buildJwks() {
  const pem = fs.readFileSync(keyPath, 'utf-8');
  const jwk = crypto.createPublicKey(pem).export({ format: 'jwk' });
  return { keys: [{ ...jwk, kid: thumbprint(jwk), alg: 'RS256', use: 'sig' }] };
}

// Se lee en cada petición, no una sola vez al arrancar: así regenerar las llaves
// no obliga a reiniciar este proceso (y el kid nuevo se publica solo).
const server = http.createServer((req, res) => {
  const path = (req.url || '').split('?')[0];

  if (path === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok\n');
  }

  if (path === `${BASE}/.well-known/jwks.json`) {
    try {
      const body = JSON.stringify(buildJwks());
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      });
      return res.end(body);
    } catch (err) {
      console.error(`no se pudo construir el JWKS desde ${keyPath}: ${err.message}`);
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end('{"error":"llave ilegible"}');
    }
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"no encontrado"}');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`JWKS de prueba en http://127.0.0.1:${PORT}${BASE}/.well-known/jwks.json`);
  console.log(`  llave: ${keyPath}`);
  console.log(`  kid:   ${buildJwks().keys[0].kid}`);
});
