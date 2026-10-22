import { createApp } from './core/app.js';
import { loadConfig } from './config.js';
import { MODULES } from './modules/index.js';
import { bootstrapAdmin } from './bootstrap.js';

const config = loadConfig();
const instance = createApp(config, MODULES);
bootstrapAdmin(instance.app, process.env);
await instance.listen();
console.log(`HyperLevel läuft auf ${config.baseUrl} (lauscht auf ${config.host}:${config.port}, Daten in ${config.dataDir})`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await instance.close();
    process.exit(0);
  });
}
