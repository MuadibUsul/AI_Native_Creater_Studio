import { z } from 'zod';

/**
 * 金额与 Credits（计划 §4.1）：
 * - 金额使用定点十进制字符串 + 明确币种，禁止浮点累计；
 * - Credits 使用整数（记账与预留均不出现小数）。
 */

export const moneySchema = z.object({
  /** 定点十进制字符串，例如 "2.50"、"-12.345" */
  amount: z.string().regex(/^-?\d+(\.\d{1,6})?$/, 'amount 必须为定点十进制字符串（禁止浮点数值）'),
  /** ISO 4217 三字母币种代码，例如 "USD"、"CNY" */
  currency: z.string().regex(/^[A-Z]{3}$/, 'currency 必须为 ISO 4217 三字母代码'),
});

/** Credits 整数（可为负：退款/调整；扣减与预留由账本类型区分） */
export const creditsSchema = z.number().int();

export type Money = z.infer<typeof moneySchema>;
export type Credits = z.infer<typeof creditsSchema>;
