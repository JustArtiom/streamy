import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Joins class names (clsx) and resolves Tailwind conflicts (tailwind-merge),
 * so cn("px-2", "px-4") gives "px-4" instead of both.
 */
export function cn(...classes: ClassValue[]) {
  return twMerge(clsx(classes));
}
