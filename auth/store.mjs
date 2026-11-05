import fs from 'node:fs';
import path from 'node:path';

/** 读 keys.json；缺失或损坏都归零，不让坏文件挡住启动。 */
export function loadKeys(file) {
  try {
    const db = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(db?.keys) ? { version: db.version ?? 1, keys: db.keys } : { version: 1, keys: [] };
  } catch {
    return { version: 1, keys: [] };
  }
}

export function saveKeys(file, db) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(db, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
