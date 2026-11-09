/**
 * Shared look for every Recharts chart. Recharts needs <XAxis>, <Tooltip>… as direct children
 * of the chart, so they are styled by spreading these presets: `<XAxis {...chartTheme.axis} dataKey="x" />`.
 */
export const chartTheme = {
  grid: { stroke: "var(--border)", strokeDasharray: "3 4" },
  axis: { tickLine: false, axisLine: false, tick: { fill: "var(--muted-foreground)", fontSize: 12 } },
  tooltip: {
    cursor: { fill: "var(--primary)", opacity: 0.06 },
    contentStyle: {
      background: "var(--popover)",
      border: "1px solid var(--border)",
      borderRadius: 10,
      boxShadow: "var(--shadow-card-hover)",
      fontSize: 13,
      color: "var(--popover-foreground)",
    },
  },
  legend: {
    iconType: "circle" as const,
    iconSize: 8,
    wrapperStyle: { fontSize: 13 },
    formatter: (value: string) => <span style={{ color: "var(--foreground)" }}>{value}</span>,
  },
  /** Thin card-coloured gap between stacked segments. */
  bar: { stroke: "var(--card)", strokeWidth: 2 },
}
