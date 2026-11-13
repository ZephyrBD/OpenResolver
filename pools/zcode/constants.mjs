/**
 * ZCode 上游事实常量（00 §1：constants.mjs 是上游事实的唯一落点）。
 * origin/appVersion 的所有默认值都从这里引用，禁止其它文件再写字面量；
 * ENV 覆盖（UGW_ZCODE_ORIGIN）由调用方（panel/api.mjs）在参数层表达。
 */

export const ZCODE_ORIGIN = 'https://zcode.z.ai';
export const ZCODE_APP_VERSION = '3.16.3';
