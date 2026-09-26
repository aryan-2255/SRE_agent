// From Amicro "IconSwap" (MIT, github.com/Subhan-code/Amicro--Micro-transitions-): blur-scale crossfade between icons.
import { AnimatePresence, motion, type HTMLMotionProps } from "motion/react";
import type { ReactNode } from "react";

export function IconSwap({ children }: { children: ReactNode }) {
  return <AnimatePresence mode="popLayout" initial={false}>{children}</AnimatePresence>;
}

export function IconSwapItem({ children, className, ...props }: HTMLMotionProps<"span">) {
  return (
    <motion.span
      initial={{ opacity: 0, scale: 0.25, filter: "blur(4px)" }}
      animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
      exit={{ opacity: 0, scale: 0.25, filter: "blur(4px)" }}
      transition={{ type: "spring", duration: 0.3, bounce: 0 }}
      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}
      className={className}
      {...props}
    >
      {children}
    </motion.span>
  );
}
