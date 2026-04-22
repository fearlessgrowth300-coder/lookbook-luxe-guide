/**
 * Atelier motion tokens — the only easing/durations allowed.
 * Used with framer-motion's `transition` prop.
 */

export const ease = {
  luxury: [0.16, 1, 0.3, 1] as const, // entrances/exits
  tactile: [0.4, 0, 0.2, 1] as const, // taps/presses
  drift: [0.22, 0.61, 0.36, 1] as const, // ambient
};

export const dur = {
  press: 0.12,
  hover: 0.22,
  page: 0.42,
  hero: 0.64,
  stagger: 0.9,
};

export const pageTransition = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -12 },
  transition: { duration: dur.page, ease: ease.luxury },
};

export const tap = {
  whileTap: { scale: 0.97 },
  transition: { duration: dur.press, ease: ease.tactile },
};
