/** Shared motion presets. framer-motion skips them under reduced motion (MotionConfig "user"). */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;

/** Staggered page-load reveal: children of a <RevealGroup> use this variant. */
export const revealItem = {
  hidden: { opacity: 0, y: 18, filter: "blur(6px)" },
  show: { opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: 0.6, ease: EASE_OUT } },
};
