import { z } from "zod";

export const generationRequestSchema = z.object({
  kind: z.enum(["image", "video"]),
  prompt: z.string().trim().min(3).max(3000),
  aspectRatio: z.enum(["1:1", "3:2", "2:3", "16:9", "9:16", "4:3", "3:4"])
});

export const generationIdSchema = z.string().uuid();
