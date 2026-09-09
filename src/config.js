import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

export const CONFIG = {
  PORT: parseInt(process.env.PORT || '20250', 10),
  HOST: process.env.HOST || '0.0.0.0',
  ROOT_DIR,
  DATA_DIR: path.join(ROOT_DIR, 'data'),
  PUBLIC_DIR: path.join(ROOT_DIR, 'public'),
  VERSION: '0.1.0',
  TIMEOUT_MS: parseInt(process.env.TIMEOUT_MS || '120000', 10), // 2 min
  MAX_LOGS: 500, // keep last 500 requests in kasdb
};
