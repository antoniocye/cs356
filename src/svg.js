function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function barChartSvg({
  title,
  rows,
  labelKey = "label",
  valueKey = "value",
  width = 920,
  height = 520,
  color = "#3867d6",
}) {
  const margin = { top: 52, right: 28, bottom: 118, left: 72 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;
  const maxValue = Math.max(1, ...rows.map((row) => Number(row[valueKey] || 0)));
  const barGap = 6;
  const barWidth = Math.max(6, (chartWidth - barGap * (rows.length - 1)) / rows.length);

  const bars = rows.map((row, index) => {
    const value = Number(row[valueKey] || 0);
    const barHeight = (value / maxValue) * chartHeight;
    const x = margin.left + index * (barWidth + barGap);
    const y = margin.top + chartHeight - barHeight;
    const label = escapeXml(row[labelKey]);
    return `
      <rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" fill="${color}" />
      <text x="${x + barWidth / 2}" y="${margin.top + chartHeight + 18}" text-anchor="end" transform="rotate(-38 ${x + barWidth / 2} ${margin.top + chartHeight + 18})" font-size="11">${label}</text>
      <text x="${x + barWidth / 2}" y="${y - 5}" text-anchor="middle" font-size="11">${value}</text>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="white"/>
  <text x="${width / 2}" y="28" text-anchor="middle" font-family="Arial, sans-serif" font-size="20" font-weight="700">${escapeXml(title)}</text>
  <line x1="${margin.left}" y1="${margin.top + chartHeight}" x2="${margin.left + chartWidth}" y2="${margin.top + chartHeight}" stroke="#222"/>
  <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + chartHeight}" stroke="#222"/>
  ${bars}
</svg>
`;
}

export function histogramSvg({
  title,
  bins,
  width = 900,
  height = 500,
  color = "#20bf6b",
}) {
  return barChartSvg({
    title,
    rows: bins.map((bin) => ({ label: bin.label, value: bin.count })),
    width,
    height,
    color,
  });
}
