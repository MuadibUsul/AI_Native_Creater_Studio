import { z } from 'zod';

/**
 * 画面上的一块区域（0–1 归一化坐标，原点左上）：对话时框选的指向、审片批注的框选、特效的作用范围共用同一形状。
 * 只用于定位，不是时间权威。
 */
export const frameRegionSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().gt(0).max(1),
  height: z.number().gt(0).max(1),
}).strict().refine((region) => region.x + region.width <= 1.0001 && region.y + region.height <= 1.0001, 'region must stay inside the frame');
export type FrameRegion = z.infer<typeof frameRegionSchema>;
