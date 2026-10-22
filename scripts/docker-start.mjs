/**
 * Container start (Docker image only): if started as root, hand the data folder to the unprivileged
 * "node" user (uid/gid 1000) – volumes and platform disks (Render, Railway, Coolify, bind mounts) are often
 * root-owned – then drop all privileges and start the server. Started with --user already? Then it just
 * starts the server. No shell, no extra packages.
 */
import { lchownSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const UID = 1000;
const GID = 1000;
const data = process.env.PGHL_DATA_DIR || '/data';

function chownTree(path) {
  lchownSync(path, UID, GID);
  const st = statSync(path, { throwIfNoEntry: false });
  if (st?.isDirectory()) for (const name of readdirSync(path)) chownTree(join(path, name));
}

if (typeof process.getuid === 'function' && process.getuid() === 0) {
  mkdirSync(data, { recursive: true });
  if (statSync(data).uid !== UID) {
    console.log(`[start] ${data} gehört nicht dem App-Nutzer – Rechte werden angepasst …`);
    chownTree(data);
  }
  process.setgroups([GID]);
  process.setgid(GID);
  process.setuid(UID);
}

await import('./dist-server/server/index.js');
