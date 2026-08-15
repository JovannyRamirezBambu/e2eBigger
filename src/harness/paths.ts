import * as path from 'path';
import * as fs from 'fs';

export const E2E_ROOT = path.resolve(__dirname, '..', '..');
export const ER_ROOT = path.resolve(E2E_ROOT, '..');
export const RUN_DIR = path.join(E2E_ROOT, 'run');
export const KEYS_DIR = path.join(RUN_DIR, 'keys');
export const LOG_DIR = path.join(RUN_DIR, 'logs');

export const repo = (name: string) => path.join(ER_ROOT, name);
export const REPO_BCB = repo('BCB_EstrellaRoja_Backend');
export const REPO_MAIN = repo('BIGER_EstrellaRoja_Main');
export const REPO_TOMTOM = repo('BIGER_EstrellaRoja_TomTom');
export const REPO_VENTAABORDO = repo('BIGER_EstrellaRoja_VentaABordo');

/** Las llaves las genera `./e2e up` (ensure_keypair en lib/common.sh). */
export function keyPath(leg: string, kind: 'private' | 'private-pkcs8' | 'public'): string {
  return path.join(KEYS_DIR, `${leg}-${kind}.pem`);
}

export function readKey(leg: string, kind: 'private' | 'private-pkcs8' | 'public'): string {
  const p = keyPath(leg, kind);
  if (!fs.existsSync(p)) {
    throw new Error(`falta la llave ${p}. Corré: ./e2e up <flujo>`);
  }
  return fs.readFileSync(p, 'utf-8');
}

export const logFile = (service: string) => path.join(LOG_DIR, `${service}.log`);
