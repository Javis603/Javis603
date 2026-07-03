import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ENDPOINT = process.env.TOKEN_MONITOR_PUBLIC_STATS_URL
  || 'https://token-monitor-hub.javis603.workers.dev/api/public/stats';
const OUTPUT_DIR = process.env.TOKEN_MONITOR_CARD_DIR
  || path.join(process.cwd(), 'assets');
const FONTS = JSON.parse(await readFile(
  process.env.TOKEN_MONITOR_CARD_FONTS || new URL('./fonts.json', import.meta.url),
  'utf8',
));

const WIDTH = 840;
const HEIGHT = 270;

const THEMES = {
  dark: {
    headline: '#F0F6FC',
    number: '#C9D1D9',
    muted: '#8B949E',
    accent: '#58A6FF',
    pulse: '#A5D6FF',
  },
  light: {
    headline: '#1F2328',
    number: '#3D444D',
    muted: '#6E7781',
    accent: '#0969DA',
    pulse: '#54AEFF',
  },
};

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function normalizeStats(data) {
  const periods = data?.periods || {};
  const summary = data?.historyPreview?.summary || {};
  const daily = Array.isArray(data?.historyPreview?.daily) ? data.historyPreview.daily : [];
  return {
    totalTokens: periods.allTime?.totalTokens ?? summary.totalTokens,
    currentStreak: summary.currentStreak,
    daily: daily
      .map((d) => Number(d?.tokens))
      .filter((n) => Number.isFinite(n) && n >= 0),
  };
}

function exactNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n).toLocaleString('en-US');
}

// The divider is the data: 30 days of token usage flattened into a hairline.
// Monotone cubic (Fritsch–Carlson) so the curve never overshoots the baseline.
function monotonePath(points) {
  const n = points.length;
  if (n === 0) return '';
  if (n === 1) return `M${points[0][0]} ${points[0][1]}`;
  const dx = [];
  const dy = [];
  const slope = [];
  for (let i = 0; i < n - 1; i += 1) {
    dx.push(points[i + 1][0] - points[i][0]);
    dy.push(points[i + 1][1] - points[i][1]);
    slope.push(dy[i] / dx[i]);
  }
  const m = [slope[0]];
  for (let i = 1; i < n - 1; i += 1) {
    if (slope[i - 1] * slope[i] <= 0) {
      m.push(0);
    } else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      m.push((w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]));
    }
  }
  m.push(slope[n - 2]);
  const fmt = (v) => Number(v.toFixed(2));
  let d = `M${fmt(points[0][0])} ${fmt(points[0][1])}`;
  for (let i = 0; i < n - 1; i += 1) {
    const x0 = points[i][0];
    const y0 = points[i][1];
    const x1 = points[i + 1][0];
    const y1 = points[i + 1][1];
    const h = dx[i] / 3;
    d += `C${fmt(x0 + h)} ${fmt(y0 + m[i] * h)} ${fmt(x1 - h)} ${fmt(y1 - m[i + 1] * h)} ${fmt(x1)} ${fmt(y1)}`;
  }
  return d;
}

// 1-2-1 centred moving average: keeps the month's shape, drops day-to-day jitter
function smoothSeries(values) {
  return values.map((v, i) => {
    const prev = values[i - 1] ?? v;
    const next = values[i + 1] ?? v;
    return (prev + 2 * v + next) / 4;
  });
}

// The line is a timeline: it flows in from the left and stops at today's dot.
function buildHairline(daily) {
  const baseline = 168;
  const lineStart = 190;
  const lineEnd = WIDTH - 190;
  const dataStart = lineStart + 56;
  const amplitude = 19;

  if (daily.length < 2) {
    return { path: `M${lineStart} ${baseline}H${lineEnd}`, endX: lineEnd, endY: baseline };
  }

  const series = smoothSeries(daily);
  const max = Math.max(...series);
  const span = lineEnd - dataStart;
  const points = [
    [lineStart, baseline],
    [dataStart - 22, baseline],
  ];
  series.forEach((tokens, i) => {
    const x = dataStart + (span * i) / (series.length - 1);
    // gentle power scale keeps quiet days visible without flattering the peak
    const v = max > 0 ? (tokens / max) ** 0.75 : 0;
    points.push([x, baseline - v * amplitude]);
  });
  const last = points[points.length - 1];
  return { path: monotonePath(points), endX: last[0], endY: last[1] };
}

function renderSvg(stats, theme) {
  const t = THEMES[theme];
  const total = exactNumber(stats.totalTokens);
  const streak = Number(stats.currentStreak);
  const totalText = total ? `${total} tokens` : 'tokens — warming up';
  const streakText = Number.isFinite(streak) && streak > 0
    ? ` · ${Math.round(streak)}-day streak`
    : '';
  const line = buildHairline(stats.daily);
  const alt = `Hello, I am Javis. ${totalText}${streakText}, live from Token Monitor.`;

  return `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">Hello, I am Javis</title>
  <desc id="desc">${escapeXml(alt)}</desc>
  <defs>
    <linearGradient id="rule" x1="190" y1="0" x2="${WIDTH - 190}" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${t.accent}" stop-opacity="0"/>
      <stop offset=".16" stop-color="${t.accent}" stop-opacity=".55"/>
      <stop offset=".5" stop-color="${t.accent}"/>
      <stop offset="1" stop-color="${t.accent}"/>
    </linearGradient>
    <linearGradient id="pulseGrad" x1="190" y1="0" x2="${WIDTH - 190}" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${t.pulse}" stop-opacity="0"/>
      <stop offset=".16" stop-color="${t.pulse}" stop-opacity=".6"/>
      <stop offset=".5" stop-color="${t.pulse}"/>
      <stop offset="1" stop-color="${t.pulse}"/>
    </linearGradient>
    <filter id="soften" x="-5%" y="-300%" width="110%" height="700%">
      <feGaussianBlur stdDeviation=".6"/>
    </filter>
  </defs>
  <style>
${FONTS.faces.map((f) => `    @font-face { font-family: '${f.family}'; font-style: ${f.style}; font-weight: ${f.weight}; src: url(data:font/woff2;base64,${f.b64}) format('woff2'); }`).join('\n')}
    .headline { font-family: ${FONTS.headline.family}; }
    .counter { font-family: ${FONTS.mono.family}; font-variant-numeric: tabular-nums; }
    .headline { animation: rise .9s cubic-bezier(.2,.6,.2,1) both; }
    .hairline { stroke-dasharray: 1 2; animation: draw 2.4s cubic-bezier(.45,0,.2,1) .4s both; }
    .pulse { animation: comet 9s linear 4s infinite; }
    .now { transform-box: fill-box; transform-origin: center; animation: fade .7s ease-out 2.5s both, beat 9s ease-in-out 4s infinite; }
    .counter { animation: fade .8s ease-out 1.5s both; }
    @keyframes rise { from { opacity: 0; transform: translateY(7px); } to { opacity: 1; transform: none; } }
    @keyframes draw { from { stroke-dashoffset: 1.35; } to { stroke-dashoffset: 0; } }
    @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
    /* -.93 = comet tip touches the dot, -1 = fully absorbed; the beat is keyed to those moments */
    @keyframes comet {
      0% { stroke-dashoffset: .2; animation-timing-function: cubic-bezier(.5,.05,.55,.95); }
      26% { stroke-dashoffset: -.93; animation-timing-function: linear; }
      30%, 100% { stroke-dashoffset: -1.14; }
    }
    @keyframes beat { 0%, 26% { transform: none; } 31% { transform: scale(1.5); } 43%, 100% { transform: none; } }
    @media (prefers-reduced-motion: reduce) {
      .headline, .hairline, .pulse, .now, .counter { animation: none; }
    }
  </style>
  <text class="headline" x="${WIDTH / 2}" y="102" text-anchor="middle" fill="${t.headline}" font-size="${FONTS.headline.size}" font-weight="${FONTS.headline.weight}" letter-spacing="${FONTS.headline.tracking}">Hello, I am ${FONTS.headline.italicName ? '<tspan font-style="italic">Javis</tspan>' : 'Javis'}</text>
  <path class="hairline" pathLength="1" d="${line.path}" stroke="url(#rule)" stroke-width="1.5"/>
  <path class="pulse" pathLength="1" d="${line.path}" stroke="url(#pulseGrad)" stroke-width="1.8" stroke-dasharray=".07 1.35" stroke-dashoffset=".2" filter="url(#soften)" opacity=".85"/>
  <circle class="now" cx="${line.endX}" cy="${line.endY}" r="2.4" fill="${t.accent}"/>
  <text class="counter" x="${WIDTH / 2}" y="219" text-anchor="middle" font-size="${FONTS.mono.size}" letter-spacing="${FONTS.mono.tracking}"><tspan fill="${t.number}">${escapeXml(totalText)}</tspan><tspan fill="${t.muted}">${escapeXml(streakText)}</tspan></text>
</svg>
`;
}

async function fetchStats() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(ENDPOINT, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return normalizeStats(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  let stats;
  try {
    stats = await fetchStats();
  } catch (error) {
    const existing = ['dark', 'light']
      .map((theme) => path.join(OUTPUT_DIR, `token-monitor-${theme}.svg`))
      .filter((file) => existsSync(file));
    if (existing.length === 2) {
      console.warn(`Keeping existing cards because stats fetch failed: ${error.message}`);
      return;
    }
    console.warn(`Rendering fallback cards because stats fetch failed: ${error.message}`);
    stats = { totalTokens: null, currentStreak: null, daily: [] };
  }
  for (const theme of ['dark', 'light']) {
    const file = path.join(OUTPUT_DIR, `token-monitor-${theme}.svg`);
    await writeFile(file, renderSvg(stats, theme), 'utf8');
    console.log(`Rendered ${file}`);
  }
}

await main();
