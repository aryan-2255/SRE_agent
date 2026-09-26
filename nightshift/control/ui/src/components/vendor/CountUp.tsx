// Adapted from React Bits "CountUp" (MIT, github.com/DavidHDev/react-bits): springs to every new value
// instead of animating once on first view, so live metrics roll smoothly as they change.
import { useMotionValue, useSpring } from "motion/react";
import { useEffect, useRef } from "react";

interface CountUpProps {
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  duration?: number;
  className?: string;
}

export default function CountUp({ value, decimals = 0, prefix = "", suffix = "", duration = 0.9, className = "" }: CountUpProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const mv = useMotionValue(value);
  const spring = useSpring(mv, { damping: 20 + 40 * (1 / duration), stiffness: 100 * (1 / duration) });
  const fmt = (n: number) =>
    prefix + new Intl.NumberFormat("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n) + suffix;

  useEffect(() => { mv.set(value); }, [value, mv]);
  useEffect(() => {
    if (ref.current) ref.current.textContent = fmt(spring.get());
    return spring.on("change", (v) => { if (ref.current) ref.current.textContent = fmt(v); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spring, decimals, prefix, suffix]);

  return <span ref={ref} className={`tabular ${className}`} />;
}
