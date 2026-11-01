/**
 * Customer names run long. A bar chart needs the head of the name, not all of
 * it — SVG text does not wrap, so a long name runs off its own left edge. The
 * full name stays in the chart summary and in the table below, so nothing is
 * lost by trimming the axis. "TN Highways Contractor — Kancheepuram" becomes
 * "TN Highways Contractor".
 */
export function shortName(name: string, max = 24): string {
  const head = name.split(' — ')[0] ?? name;
  return head.length > max ? `${head.slice(0, max - 1)}…` : head;
}
