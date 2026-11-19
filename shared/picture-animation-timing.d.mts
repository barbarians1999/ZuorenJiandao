export interface PictureTimingItem {
  kind: string; startFrame: number; durationInFrames: number; props?: Record<string, unknown>;
}
export interface PictureAnimationWindow { from: number; until: number }
export const PICTURE_ANIMATION_IDS: Set<string>;
export function pictureAnimationTiming(item: PictureTimingItem): { entrance: PictureAnimationWindow | null; exit: PictureAnimationWindow | null };
export function pictureAnimationProgress(item: PictureTimingItem, frame: number): { entrance: number; exit: number };
export function pictureAnimationWindows(item: PictureTimingItem): Array<[number, number]>;
export function pictureOnlyProps(props: unknown): boolean;
export function neutralPictureProps(item: PictureTimingItem): boolean;
