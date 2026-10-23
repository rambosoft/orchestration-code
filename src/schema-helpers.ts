import { z } from "zod";
import { clampedText } from "./handoffs.js";

// Tolerant building blocks for schemas that validate model output: text is clamped, lists are coerced, unknown keys are dropped and an unusable
// enum value falls back instead of failing. Identifiers and anything protected are validated strictly by the callers, never here.
export const text = (max: number) => clampedText(max);
export const optionalText = (max: number) => z.preprocess(value => typeof value === "string" && value.trim() ? value : undefined, text(max).optional());
export const strings = (max: number, each: number, min = 0) => z.preprocess(value => (value == null ? [] : Array.isArray(value) ? value : [value]).filter(item => typeof item === "string" && item.trim()).slice(0, max), z.array(text(each)).min(min));
export const level = <T extends string>(values: readonly [T, ...T[]], fallback: T) => z.preprocess(value => typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : value, z.enum(values).catch(fallback));
export const objects = (max: number) => (value: unknown) => Array.isArray(value) ? value.filter(item => item && typeof item === "object").slice(0, max) : [];
