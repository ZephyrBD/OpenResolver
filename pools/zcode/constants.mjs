/**
 * ZCode 上游事实常量（00 §1：constants.mjs 是上游事实的唯一落点）。
 * origin/appVersion 的所有默认值都从这里引用，禁止其它文件再写字面量；
 * ENV 覆盖（UGW_ZCODE_ORIGIN）由调用方（panel/api.mjs）在参数层表达。
 */

export const ZCODE_ORIGIN = 'https://zcode.z.ai';

// 3.18.2：领取活动门槛 2026-10-23 提到 3.16.1，marketing/touch 需要 3.17.1+。
export const ZCODE_APP_VERSION = '3.18.2';

/** /api/v1/marketing/touch 在低于该版本时返回 0 条活动，脚本侧按未部署跳过。 */
export const ZCODE_MARKETING_MIN_APP_VERSION = '3.17.1';
