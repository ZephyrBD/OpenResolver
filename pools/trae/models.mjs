// 静态模型目录：SOLO 上游没有 model/list 端点（vendor/cpa-trae 用的是
// get_detail_param 动态发现，需真实凭据），网关侧退化为静态表（简报第 7 块裁决）。
//
// 表来源：glm-5.2 按简报要求（context 1e6 / max 32768，vendor staticSoloModels 记 200000，
// 以简报为准）；其余抄 vendor/cpa-trae/trae/main.go:749-763 staticSoloModels 的 2026-09
// 实测快照（MIT），verified=false 标注"未逐个验证"。注意 vendor issue #9/#10 证据：非
// Official 的 DeepSeek-V4-Flash/Pro 在 solo_work_lite 通道是死道（流内 4001），
// -Official 后缀那对才是活配置——死道两条已按 M5 评审裁决删除。

import fs from 'node:fs';
import { DEFAULT_MODEL } from './constants.mjs';

const TABLE_URL = new URL('./models.json', import.meta.url);

export function loadStaticModels() {
  const list = JSON.parse(fs.readFileSync(TABLE_URL, 'utf8'));
  return list.map((m) => ({ ...m }));
}

export function createTraeModelCatalog() {
  const models = loadStaticModels();
  const byId = new Map(models.map((m) => [m.id, m]));

  return {
    models: () => models.map((m) => ({ ...m })),
    configFor: (id) => byId.get(id) ?? null,
    defaultModel: DEFAULT_MODEL,
  };
}
