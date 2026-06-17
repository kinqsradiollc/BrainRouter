/* BrainRouter — Investor deck generator (PptxGenJS) — clean, number-free pass */
const pptxgen = require("pptxgenjs");
const React = require("react");
const ReactDOMServer = require("react-dom/server");
const sharp = require("sharp");
const FA = require("react-icons/fa");

// ---------- theme ----------
const T = {
  bg: "0A0C0E",
  card: "14181C",
  card2: "11161A",
  border: "262D34",
  borderSoft: "1E242A",
  teal: "34C28E",
  tealDk: "1E9E73",
  tealInk: "0F1F18",
  red: "EF6F6A",
  redInk: "20100F",
  white: "F4F7FA",
  text: "CCD3DA",
  muted: "9AA3AD",
  dim: "5C646D",
};
const FH = "Trebuchet MS"; // headers + labels
const FB = "Tahoma";       // body
const FM = "Courier New";  // code only
const PW = 13.33, PH = 7.5, MX = 0.78, CW = PW - 2 * MX;

const pres = new pptxgen();
pres.defineLayout({ name: "W", width: PW, height: PH });
pres.layout = "W";
pres.author = "Anh Dang";
pres.title = "BrainRouter — Investor Overview";

// ---------- icons ----------
function renderIcon(Icon, color, size = 256) {
  return ReactDOMServer.renderToStaticMarkup(React.createElement(Icon, { color, size: String(size) }));
}
async function icon(Icon, color = "#34C28E", size = 256) {
  const png = await sharp(Buffer.from(renderIcon(Icon, color, size))).png().toBuffer();
  return "image/png;base64," + png.toString("base64");
}
const TEAL = "#34C28E", REDC = "#EF6F6A", WHT = "#EAF0F5";

// ---------- helpers ----------
const sh = () => ({ type: "outer", color: "000000", blur: 14, offset: 4, angle: 90, opacity: 0.38 });

function bg(slide, glow = true) {
  slide.background = { color: T.bg };
  if (glow) {
    slide.addShape(pres.shapes.OVAL, { x: 8.6, y: -2.8, w: 8.2, h: 6.6, fill: { color: T.teal, transparency: 95 }, line: { type: "none" } });
    slide.addShape(pres.shapes.OVAL, { x: 10.2, y: -1.5, w: 4.8, h: 4.2, fill: { color: T.teal, transparency: 91 }, line: { type: "none" } });
  }
}
function kicker(slide, text, y = 0.66) {
  slide.addShape(pres.shapes.OVAL, { x: MX, y: y + 0.055, w: 0.12, h: 0.12, fill: { color: T.teal }, line: { type: "none" } });
  slide.addText(text.toUpperCase(), { x: MX + 0.27, y: y - 0.05, w: 11, h: 0.34, fontFace: FH, fontSize: 12, color: T.teal, charSpacing: 3, bold: true, margin: 0, valign: "middle" });
}
function title(slide, text, o = {}) {
  slide.addText(text, { x: MX, y: o.y ?? 1.12, w: o.w ?? CW, h: o.h ?? 0.95, fontFace: FH, fontSize: o.size ?? 33, color: T.white, bold: true, margin: 0, valign: "top", lineSpacingMultiple: 1.03 });
}
function footer(slide) {
  slide.addShape(pres.shapes.OVAL, { x: MX, y: 7.12, w: 0.1, h: 0.1, fill: { color: T.teal }, line: { type: "none" } });
  slide.addText("brainrouter", { x: MX + 0.21, y: 6.99, w: 3, h: 0.34, fontFace: FH, fontSize: 10.5, color: T.dim, bold: true, charSpacing: 1, valign: "middle", margin: 0 });
}
function card(slide, x, y, w, h, o = {}) {
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x, y, w, h, rectRadius: o.r ?? 0.11,
    fill: { color: o.fill ?? T.card }, line: { color: o.border ?? T.border, width: 1 },
    shadow: o.shadow ? sh() : undefined,
  });
}
function iconChip(slide, x, y, data, size = 0.66, ink = T.tealInk, ring = T.teal) {
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: size, h: size, rectRadius: 0.1, fill: { color: ink }, line: { color: ring, width: 1.25 } });
  const p = size * 0.28;
  slide.addImage({ data, x: x + p, y: y + p, w: size - 2 * p, h: size - 2 * p });
}
function connect(slide, x1, y1, x2, y2, color = T.border, w = 1, tr = 20) {
  const x = Math.min(x1, x2), y = Math.min(y1, y2), ww = Math.abs(x2 - x1), hh = Math.abs(y2 - y1);
  const flipV = (x2 - x1) * (y2 - y1) < 0;
  slide.addShape(pres.shapes.LINE, { x, y, w: ww, h: hh, line: { color, width: w, transparency: tr }, flipV });
}
function arrow(slide, x, y, color = T.teal) {
  slide.addShape(pres.shapes.ISOSCELES_TRIANGLE, { x, y, w: 0.16, h: 0.18, rotate: 90, fill: { color }, line: { type: "none" } });
}
function chip(slide, x, y, text, o = {}) {
  const w = o.w ?? 2.0, h = o.h ?? 0.42;
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius: h / 2, fill: { color: o.fill ?? T.card }, line: { color: o.border ?? T.border, width: 1 } });
  slide.addText(text, { x, y: y - 0.01, w, h, fontFace: o.mono ? FM : FH, fontSize: o.size ?? 11, color: o.color ?? T.text, bold: o.bold ?? true, align: "center", valign: "middle", margin: 0, charSpacing: o.cs ?? 0.5 });
}
function wordmark(slide, x, y, data, scale = 1) {
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: 0.44 * scale, h: 0.44 * scale, rectRadius: 0.11, fill: { color: T.tealInk }, line: { color: T.teal, width: 1.4 } });
  slide.addImage({ data, x: x + 0.11 * scale, y: y + 0.11 * scale, w: 0.22 * scale, h: 0.22 * scale });
  slide.addText("BrainRouter", { x: x + 0.6 * scale, y: y - 0.02, w: 4, h: 0.44 * scale, fontFace: FH, fontSize: 16 * scale, color: T.white, bold: true, charSpacing: 0.5, valign: "middle", margin: 0 });
}

async function main() {
  const I = {
    brain: await icon(FA.FaBrain, TEAL),
    coins: await icon(FA.FaCoins, REDC),
    random: await icon(FA.FaRandom, REDC),
    lock: await icon(FA.FaLock, REDC),
    stream: await icon(FA.FaStream, TEAL),
    db: await icon(FA.FaDatabase, TEAL),
    cross: await icon(FA.FaCrosshairs, TEAL),
    finger: await icon(FA.FaFingerprint, TEAL),
    down: await icon(FA.FaArrowDown, TEAL),
    bolt: await icon(FA.FaBolt, TEAL),
    filter: await icon(FA.FaFilter, TEAL),
    graph: await icon(FA.FaProjectDiagram, TEAL),
    speed: await icon(FA.FaTachometerAlt, TEAL),
    target: await icon(FA.FaBullseye, TEAL),
    compress: await icon(FA.FaCompressArrowsAlt, TEAL),
    coinsT: await icon(FA.FaCoins, TEAL),
    server: await icon(FA.FaServer, TEAL),
    terminal: await icon(FA.FaTerminal, TEAL),
    desktop: await icon(FA.FaDesktop, TEAL),
    chart: await icon(FA.FaChartBar, TEAL),
    cubes: await icon(FA.FaCubes, TEAL),
    rocket: await icon(FA.FaRocket, TEAL),
    check: await icon(FA.FaCheckCircle, TEAL),
    scale: await icon(FA.FaBalanceScale, TEAL),
    users: await icon(FA.FaUsers, TEAL),
    share: await icon(FA.FaShareAlt, TEAL),
    layers: await icon(FA.FaLayerGroup, TEAL),
    github: await icon(FA.FaGithub, WHT),
    npm: await icon(FA.FaNpm, TEAL),
  };

  // ============================================================ 1 — TITLE
  let s = pres.addSlide(); bg(s, true);
  wordmark(s, MX, 0.66, I.brain, 1);
  s.addText("THE MEMORY LAYER FOR AI AGENTS", { x: MX, y: 2.5, w: 8.4, h: 0.34, fontFace: FH, fontSize: 12.5, color: T.teal, charSpacing: 3, bold: true, margin: 0 });
  s.addText("Agents that\nremember.", { x: MX - 0.04, y: 2.95, w: 9, h: 1.9, fontFace: FH, fontSize: 58, color: T.white, bold: true, margin: 0, lineSpacingMultiple: 0.98 });
  s.addText("Capture what matters. Forget what doesn't. Surface the right context on every prompt.",
    { x: MX, y: 5.0, w: 7.4, h: 0.7, fontFace: FB, fontSize: 15, color: T.text, margin: 0, lineSpacingMultiple: 1.3 });
  chip(s, MX, 5.95, "Live on npm", { w: 1.95, size: 11, color: T.teal, fill: T.tealInk, border: T.tealDk });
  chip(s, MX + 2.15, 5.95, "Open source", { w: 1.95, size: 11, color: T.text });
  s.addText("Anh Dang     ·     [ Event ]", { x: MX, y: 6.72, w: 8, h: 0.3, fontFace: FH, fontSize: 12, color: T.muted, bold: true, charSpacing: 0.5, margin: 0 });
  // hero graph motif
  const cx = 10.6, cy = 4.0;
  const sats = [[-1.65, -1.3, 0.30], [0.15, -1.8, 0.24], [1.8, -0.9, 0.32], [1.6, 1.1, 0.26], [-0.3, 1.75, 0.30], [-1.8, 0.6, 0.22]];
  sats.forEach(([dx, dy]) => connect(s, cx, cy, cx + dx, cy + dy, T.teal, 1.25, 50));
  connect(s, cx + sats[0][0], cy + sats[0][1], cx + sats[1][0], cy + sats[1][1], T.border, 1, 58);
  connect(s, cx + sats[2][0], cy + sats[2][1], cx + sats[3][0], cy + sats[3][1], T.border, 1, 58);
  sats.forEach(([dx, dy, r], i) => {
    const solid = i % 2 === 0;
    s.addShape(pres.shapes.OVAL, { x: cx + dx - r / 2, y: cy + dy - r / 2, w: r, h: r, fill: { color: solid ? T.teal : T.card }, line: { color: T.teal, width: 1.4 } });
  });
  s.addShape(pres.shapes.OVAL, { x: cx - 0.36, y: cy - 0.36, w: 0.72, h: 0.72, fill: { color: T.tealInk }, line: { color: T.teal, width: 2 }, shadow: sh() });
  s.addImage({ data: I.brain, x: cx - 0.19, y: cy - 0.19, w: 0.38, h: 0.38 });

  // ============================================================ 2 — PROBLEM
  s = pres.addSlide(); bg(s, false);
  kicker(s, "The problem");
  title(s, "Every session, your agent\nstarts from zero.", { size: 36, h: 1.5, y: 1.15 });
  s.addText("LLMs have no memory between conversations. Your agent re-learns the same facts, re-reads the same files, and re-asks the same questions — every time.",
    { x: MX, y: 3.2, w: 6.4, h: 1.3, fontFace: FB, fontSize: 15, color: T.text, margin: 0, lineSpacingMultiple: 1.35 });
  s.addText([
    { text: "The smartest model in the world ", options: { color: T.text } },
    { text: "still has amnesia.", options: { color: T.teal, bold: true } },
  ], { x: MX, y: 4.85, w: 6.4, h: 0.6, fontFace: FH, fontSize: 19, margin: 0 });
  const px = 7.65, plabels = ["First chat", "A week later", "A month later"];
  plabels.forEach((t, i) => {
    const y = 1.7 + i * 1.32;
    card(s, px, y, 4.95, 1.08, { fill: T.card2, border: T.borderSoft });
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: px + 0.3, y: y + 0.31, w: 0.46, h: 0.46, rectRadius: 0.1, fill: { color: T.redInk }, line: { color: T.red, width: 1.2 } });
    s.addText("↺", { x: px + 0.3, y: y + 0.29, w: 0.46, h: 0.46, fontFace: FB, fontSize: 18, color: T.red, align: "center", valign: "middle", margin: 0 });
    s.addText(t, { x: px + 0.98, y: y + 0.22, w: 3.7, h: 0.34, fontFace: FH, fontSize: 15, bold: true, color: T.white, margin: 0, valign: "middle" });
    s.addText("context rebuilt from scratch", { x: px + 0.98, y: y + 0.56, w: 3.8, h: 0.3, fontFace: FB, fontSize: 11.5, color: T.muted, margin: 0, valign: "middle" });
  });
  footer(s);

  // ============================================================ 3 — WORKAROUNDS
  s = pres.addSlide(); bg(s, false);
  kicker(s, "Why it's hard");
  title(s, "Today's fixes don't scale");
  const w3 = [
    [I.coins, "Dump the history", "Stuff every message into the prompt — it blows the context window and burns tokens."],
    [I.random, "Flat vector DB", "Returns what's mathematically close, not what's useful. Noise in, noise out."],
    [I.lock, "Static prompts", "Hand-written rules with no feedback loop. Nothing improves; the agent never learns."],
  ];
  const cw3 = (CW - 2 * 0.42) / 3;
  w3.forEach(([ic, t, d], i) => {
    const x = MX + i * (cw3 + 0.42);
    card(s, x, 2.25, cw3, 2.75, { border: T.borderSoft, shadow: true });
    s.addShape(pres.shapes.RECTANGLE, { x, y: 2.25, w: cw3, h: 0.06, fill: { color: T.red }, line: { type: "none" } });
    iconChip(s, x + 0.45, 2.72, ic, 0.72, T.redInk, T.red);
    s.addText(t, { x: x + 0.45, y: 3.68, w: cw3 - 0.8, h: 0.45, fontFace: FH, fontSize: 18.5, bold: true, color: T.white, margin: 0 });
    s.addText(d, { x: x + 0.45, y: 4.18, w: cw3 - 0.85, h: 0.75, fontFace: FB, fontSize: 12.5, color: T.muted, margin: 0, lineSpacingMultiple: 1.25 });
  });
  card(s, MX, 5.42, CW, 0.74, { fill: T.tealInk, border: T.tealDk });
  s.addText([
    { text: "The result:   ", options: { color: T.teal, bold: true } },
    { text: "expensive, forgetful, and never improving.", options: { color: T.white } },
  ], { x: MX, y: 5.42, w: CW, h: 0.74, fontFace: FH, fontSize: 16.5, align: "center", valign: "middle", margin: 0 });
  footer(s);

  // ============================================================ 4 — INSIGHT
  s = pres.addSlide(); bg(s, false);
  kicker(s, "The insight");
  title(s, "Model memory like the brain");
  s.addText("Short-term feeds long-term. Unused facts fade. Used ones get reinforced.", { x: MX, y: 1.92, w: 11, h: 0.4, fontFace: FB, fontSize: 15, color: T.text, margin: 0 });
  const flow = ["Dialogue", "Short-term\nbuffer", "Long-term\nstore", "Identity +\nactive task"];
  const fw = 2.5, gap = (CW - flow.length * fw) / (flow.length - 1), fy = 2.85, fh = 1.3;
  flow.forEach((t, i) => {
    const x = MX + i * (fw + gap), active = i >= 2;
    card(s, x, fy, fw, fh, { fill: active ? T.tealInk : T.card, border: active ? T.tealDk : T.border, shadow: true });
    s.addText(t, { x, y: fy, w: fw, h: fh, fontFace: FH, fontSize: 16.5, bold: true, color: active ? T.white : T.text, align: "center", valign: "middle", margin: 0 });
    if (i < flow.length - 1) arrow(s, x + fw + gap / 2 - 0.08, fy + fh / 2 - 0.09);
  });
  const pr = [[I.down, "Decay", "Unused facts fade away."], [I.bolt, "Reinforcement", "Used facts grow stronger."], [I.graph, "Graph", "Related facts stay linked."]];
  const pw = (CW - 2 * 0.42) / 3;
  pr.forEach(([ic, t, d], i) => {
    const x = MX + i * (pw + 0.42);
    card(s, x, 5.15, pw, 1.12, { border: T.borderSoft });
    iconChip(s, x + 0.32, 5.42, ic, 0.58);
    s.addText(t, { x: x + 1.05, y: 5.4, w: pw - 1.2, h: 0.32, fontFace: FH, fontSize: 14.5, bold: true, color: T.white, margin: 0, valign: "middle" });
    s.addText(d, { x: x + 1.05, y: 5.74, w: pw - 1.2, h: 0.32, fontFace: FB, fontSize: 11.5, color: T.muted, margin: 0, valign: "middle" });
  });
  footer(s);

  // ============================================================ 5 — ENGINE / LAYERS
  s = pres.addSlide(); bg(s, false);
  kicker(s, "What we built");
  title(s, "A cognitive memory engine");
  s.addText("Four layers, each with its own lifetime — short-term feeds long-term; the rest persist or evict based on activity.",
    { x: MX, y: 1.92, w: 11.5, h: 0.4, fontFace: FB, fontSize: 15, color: T.text, margin: 0 });
  const layers = [
    [I.stream, "SensoryStream", "Raw dialogue buffer", "Transient"],
    [I.db, "CognitiveRecord", "Classified facts that decay", "Long-term"],
    [I.cross, "ContextualFocus", "Heat-scored task scenes", "Medium"],
    [I.finger, "CoreIdentity", "Profile + hard rules", "Permanent"],
  ];
  const lw = (CW - 3 * 0.32) / 4, ly = 2.65, lh = 3.15;
  layers.forEach(([ic, t, d, life], i) => {
    const x = MX + i * (lw + 0.32);
    card(s, x, ly, lw, lh, { border: T.border, shadow: true });
    iconChip(s, x + 0.34, ly + 0.4, ic, 0.74);
    s.addText(t, { x: x + 0.34, y: ly + 1.4, w: lw - 0.5, h: 0.6, fontFace: FH, fontSize: 16.5, bold: true, color: T.white, margin: 0, lineSpacingMultiple: 0.95 });
    s.addText(d, { x: x + 0.34, y: ly + 2.0, w: lw - 0.55, h: 0.7, fontFace: FB, fontSize: 12, color: T.muted, margin: 0, lineSpacingMultiple: 1.2 });
    chip(s, x + 0.34, ly + lh - 0.6, life, { w: lw - 0.68, size: 10.5, color: T.teal, fill: T.tealInk, border: T.tealDk, h: 0.38 });
  });
  footer(s);

  // ============================================================ 6 — RECALL
  s = pres.addSlide(); bg(s, false);
  kicker(s, "How recall works");
  title(s, "The right memories, on every prompt");
  const stages = [
    ["Query", "what's asked"],
    ["Retrieve", "keyword · vector · path"],
    ["Fuse & rank", "decay · freshness · use"],
    ["Judge", "drop off-topic"],
    ["Graph walk", "pull related"],
    ["Prompt", "only what matters"],
  ];
  const py = 2.7, ph2 = 1.5, sw = (CW - 5 * 0.28) / 6;
  stages.forEach(([t, d], i) => {
    const x = MX + i * (sw + 0.28), last = i === stages.length - 1;
    card(s, x, py, sw, ph2, { fill: last ? T.tealInk : T.card, border: last ? T.teal : T.border, shadow: true });
    s.addText(t, { x: x + 0.05, y: py + 0.3, w: sw - 0.1, h: 0.5, fontFace: FH, fontSize: 14.5, bold: true, color: last ? T.white : T.teal, align: "center", margin: 0, valign: "middle" });
    s.addText(d, { x: x + 0.08, y: py + 0.82, w: sw - 0.16, h: 0.5, fontFace: FB, fontSize: 10, color: T.muted, align: "center", margin: 0, lineSpacingMultiple: 1.05 });
    if (i < stages.length - 1) arrow(s, x + sw + 0.28 / 2 - 0.08, py + ph2 / 2 - 0.09);
  });
  card(s, MX, 4.85, CW, 1.3, { fill: T.card2, border: T.borderSoft });
  s.addText("Three retrievers fused. A judge filters. The graph connects.", { x: MX + 0.55, y: 5.05, w: CW - 1.1, h: 0.5, fontFace: FH, fontSize: 19, bold: true, color: T.white, margin: 0, valign: "middle" });
  s.addText("Only what's relevant reaches the prompt — a sliver of the context, never the whole history.",
    { x: MX + 0.55, y: 5.58, w: CW - 1.1, h: 0.45, fontFace: FB, fontSize: 13, color: T.muted, margin: 0 });
  footer(s);

  // ============================================================ 7 — MOAT
  s = pres.addSlide(); bg(s, false);
  kicker(s, "Why it's different");
  title(s, "It doesn't just store — it learns");
  const moat = [
    [I.down, "It forgets", "Memories fade on a half-life. Instructions stay forever; code facts fade faster than who you are."],
    [I.bolt, "It reinforces", "When the agent uses a memory, that memory gets stronger — and its decay clock resets."],
    [I.filter, "It judges", "An LLM relevance check drops keyword-matches that aren't actually on topic."],
    [I.graph, "It connects", "A graph walk surfaces related facts plain keyword or vector search would never reach."],
  ];
  const my = 1.95, mh = 1.08, mgap = 0.18;
  moat.forEach(([ic, t, d], i) => {
    const y = my + i * (mh + mgap);
    card(s, MX, y, CW, mh, { border: T.borderSoft });
    iconChip(s, MX + 0.42, y + (mh - 0.62) / 2, ic, 0.62);
    s.addText(t, { x: MX + 1.32, y, w: 2.7, h: mh, fontFace: FH, fontSize: 17.5, bold: true, color: T.white, valign: "middle", margin: 0 });
    s.addShape(pres.shapes.LINE, { x: MX + 4.15, y: y + 0.22, w: 0, h: mh - 0.44, line: { color: T.border, width: 1 } });
    s.addText(d, { x: MX + 4.5, y, w: CW - 4.9, h: mh, fontFace: FB, fontSize: 12.5, color: T.text, valign: "middle", margin: 0, lineSpacingMultiple: 1.15 });
  });
  footer(s);

  // ============================================================ 8 — PAYOFF (was numbers)
  s = pres.addSlide(); bg(s, false);
  kicker(s, "The payoff");
  title(s, "What that buys you");
  const pay = [
    [I.coinsT, "Fewer tokens", "A sliver of the context — not the whole history every time."],
    [I.speed, "Faster replies", "Less for the model to read means quicker answers."],
    [I.target, "Sharper recall", "The right memory surfaces — nearly every time."],
    [I.compress, "Flat cost at scale", "Spend stays steady as the agent remembers more."],
  ];
  const stw = (CW - 3 * 0.32) / 4, sty = 2.35, sth = 2.9;
  pay.forEach(([ic, t, d], i) => {
    const x = MX + i * (stw + 0.32);
    card(s, x, sty, stw, sth, { border: T.border, shadow: true });
    iconChip(s, x + 0.34, sty + 0.4, ic, 0.74);
    s.addText(t, { x: x + 0.34, y: sty + 1.4, w: stw - 0.5, h: 0.6, fontFace: FH, fontSize: 17, bold: true, color: T.white, margin: 0, lineSpacingMultiple: 0.95 });
    s.addText(d, { x: x + 0.34, y: sty + 2.0, w: stw - 0.55, h: 0.75, fontFace: FB, fontSize: 12, color: T.muted, margin: 0, lineSpacingMultiple: 1.22 });
  });
  s.addText("Benchmarked, reproducible, and open — the proof is ready when you are.",
    { x: MX, y: 5.5, w: CW, h: 0.4, fontFace: FH, fontSize: 13.5, bold: true, color: T.teal, align: "center", margin: 0 });
  footer(s);

  // ============================================================ 9 — SURFACES
  s = pres.addSlide(); bg(s, false);
  kicker(s, "The product");
  title(s, "One memory store. Four ways to plug in.");
  const surf = [
    [I.server, "MCP Server", "Drop-in memory & skills for any MCP client — Claude Desktop, Cursor, your own agent.", "Live"],
    [I.terminal, "Terminal CLI", "A memory-native coding agent with multi-agent orchestration.", "Live"],
    [I.desktop, "Desktop App", "Native Mac & Windows shell over the same engine.", "Alpha"],
    [I.chart, "Web Dashboard", "See the memory — recalls, contradictions, hosted chat.", "Shipping"],
  ];
  const gw = (CW - 0.38) / 2, gh = 1.92, gy0 = 2.05;
  surf.forEach(([ic, t, d, badge], i) => {
    const x = MX + (i % 2) * (gw + 0.38), y = gy0 + Math.floor(i / 2) * (gh + 0.34);
    card(s, x, y, gw, gh, { border: T.border, shadow: true });
    iconChip(s, x + 0.42, y + 0.42, ic, 0.78);
    s.addText(t, { x: x + 1.48, y: y + 0.42, w: gw - 3.0, h: 0.45, fontFace: FH, fontSize: 19, bold: true, color: T.white, margin: 0, valign: "middle" });
    chip(s, x + gw - 1.45, y + 0.46, badge, { w: 1.15, size: 10, color: T.teal, fill: T.tealInk, border: T.tealDk, h: 0.38, cs: 1 });
    s.addText(d, { x: x + 1.48, y: y + 0.98, w: gw - 1.8, h: 0.82, fontFace: FB, fontSize: 12.5, color: T.text, margin: 0, lineSpacingMultiple: 1.22 });
  });
  s.addText("All four share the same brain — sign in once, every surface sees the same memory.", { x: MX, y: 6.5, w: CW, h: 0.35, fontFace: FH, fontSize: 13.5, bold: true, color: T.teal, align: "center", margin: 0 });
  footer(s);

  // ============================================================ 10 — TRACTION
  s = pres.addSlide(); bg(s, false);
  kicker(s, "Traction");
  title(s, "Shipping, in the open");
  const trac = [
    [I.cubes, "Live on npm", "the engine and CLI are public and installable today"],
    [I.rocket, "Weekly releases", "a steady cadence — every release adds capability"],
    [I.check, "Public benchmarks", "committed result sets, reproducible by anyone"],
    [I.scale, "MIT licensed", "open source, end to end"],
  ];
  const trw = (CW - 0.38) / 2, trh = 1.12;
  trac.forEach(([ic, t, d], i) => {
    const x = MX + (i % 2) * (trw + 0.38), y = 2.0 + Math.floor(i / 2) * (trh + 0.3);
    card(s, x, y, trw, trh, { border: T.borderSoft });
    iconChip(s, x + 0.36, y + (trh - 0.62) / 2, ic, 0.62);
    s.addText(t, { x: x + 1.22, y: y + 0.2, w: trw - 1.5, h: 0.4, fontFace: FH, fontSize: 16.5, bold: true, color: T.white, margin: 0, valign: "middle" });
    s.addText(d, { x: x + 1.22, y: y + 0.6, w: trw - 1.45, h: 0.4, fontFace: FB, fontSize: 11.5, color: T.muted, margin: 0, valign: "middle" });
  });
  const tly = 5.1;
  s.addText("THE PATH SO FAR", { x: MX, y: tly - 0.34, w: 5, h: 0.3, fontFace: FH, fontSize: 10.5, color: T.dim, charSpacing: 2.5, bold: true, margin: 0 });
  s.addShape(pres.shapes.LINE, { x: MX + 0.1, y: tly + 0.42, w: CW - 0.2, h: 0, line: { color: T.border, width: 1.5 } });
  const rel = ["Parity", "Workflows", "Dashboard", "Build loop", "Accuracy", "Desktop"];
  const rgap = (CW - 0.2) / (rel.length - 1);
  rel.forEach((th, i) => {
    const x = MX + 0.1 + i * rgap, last = i === rel.length - 1;
    s.addShape(pres.shapes.OVAL, { x: x - 0.08, y: tly + 0.34, w: 0.16, h: 0.16, fill: { color: last ? T.teal : T.card }, line: { color: T.teal, width: 1.5 } });
    s.addText(th, { x: x - 0.85, y: tly + 0.6, w: 1.7, h: 0.3, fontFace: FH, fontSize: 11.5, bold: true, color: last ? T.teal : T.text, align: "center", margin: 0 });
  });
  footer(s);

  // ============================================================ 11 — WHY NOW
  s = pres.addSlide(); bg(s, false);
  kicker(s, "Why now");
  title(s, "Memory is becoming its own layer");
  const why = [
    [I.users, "Agents are everywhere", "Coding, support, ops, research — every agent hits the same wall: it can't remember a thing."],
    [I.layers, "A foundational layer", "The database was to apps what memory is to agents — infrastructure, not a feature."],
    [I.share, "Cross-vendor by design", "Federation lets agents on any vendor share one brain — the neutral standard."],
  ];
  const ww = (CW - 2 * 0.42) / 3, wy = 2.1, whh = 2.7;
  why.forEach(([ic, t, d], i) => {
    const x = MX + i * (ww + 0.42);
    card(s, x, wy, ww, whh, { border: T.border, shadow: true });
    iconChip(s, x + 0.4, wy + 0.4, ic, 0.76);
    s.addText(t, { x: x + 0.4, y: wy + 1.35, w: ww - 0.7, h: 0.7, fontFace: FH, fontSize: 16.5, bold: true, color: T.white, margin: 0, lineSpacingMultiple: 0.98 });
    s.addText(d, { x: x + 0.4, y: wy + 1.98, w: ww - 0.72, h: 0.72, fontFace: FB, fontSize: 12, color: T.muted, margin: 0, lineSpacingMultiple: 1.22 });
  });
  card(s, MX, 5.15, CW, 0.95, { fill: T.tealInk, border: T.tealDk });
  s.addText([
    { text: "We're not building a better chatbot. ", options: { color: T.white } },
    { text: "We're building the memory infrastructure underneath all of them.", options: { color: T.teal, bold: true } },
  ], { x: MX + 0.4, y: 5.15, w: CW - 0.8, h: 0.95, fontFace: FH, fontSize: 17, align: "center", valign: "middle", margin: 0, lineSpacingMultiple: 1.1 });
  footer(s);

  // ============================================================ 12 — ROADMAP
  s = pres.addSlide(); bg(s, false);
  kicker(s, "Roadmap");
  title(s, "Where it's going");
  const road = [
    ["NOW", "Memory accuracy, a multi-agent CLI, and a live view of the running fleet.", true],
    ["NEXT", "Full agent-runtime parity, and the desktop app in alpha.", false],
    ["SOON", "A plugin & skill marketplace, plus live sync with Git and GitHub.", false],
    ["VISION", "The memory standard every agent — on any vendor — plugs into.", false],
  ];
  const rdx = MX + 0.15, rdh = 1.0;
  s.addShape(pres.shapes.LINE, { x: rdx, y: 2.35, w: 0, h: 3 * rdh + 0.1, line: { color: T.border, width: 1.5 } });
  road.forEach(([tag, d, now], i) => {
    const y = 2.3 + i * rdh;
    s.addShape(pres.shapes.OVAL, { x: rdx - 0.11, y, w: 0.22, h: 0.22, fill: { color: now ? T.teal : T.card }, line: { color: T.teal, width: 1.75 } });
    s.addText(tag, { x: rdx + 0.45, y: y - 0.1, w: 2.1, h: 0.45, fontFace: FH, fontSize: 18, bold: true, color: now ? T.teal : T.white, charSpacing: 1.5, margin: 0, valign: "middle" });
    s.addText(d, { x: rdx + 2.7, y: y - 0.12, w: CW - 3.0, h: 0.6, fontFace: FB, fontSize: 13.5, color: T.text, margin: 0, lineSpacingMultiple: 1.18, valign: "middle" });
  });
  footer(s);

  // ============================================================ 13 — CLOSE
  s = pres.addSlide(); bg(s, true);
  wordmark(s, MX, 0.7, I.brain, 1);
  s.addText("Agents that remember.", { x: MX - 0.04, y: 2.55, w: 10, h: 1.3, fontFace: FH, fontSize: 52, bold: true, color: T.white, margin: 0 });
  s.addText("BrainRouter — the cognitive memory layer for AI agents.", { x: MX, y: 3.8, w: 9.5, h: 0.5, fontFace: FB, fontSize: 16, color: T.text, margin: 0 });
  const ctas = [[I.github, "github.com/kinqsradiollc/BrainRouter"], [I.npm, "npm i -g @kinqs/brainrouter-cli"]];
  ctas.forEach(([ic, t], i) => {
    const x = MX + i * 5.45;
    card(s, x, 4.7, 5.15, 0.7, { fill: T.card, border: T.border });
    s.addImage({ data: ic, x: x + 0.3, y: 4.9, w: 0.3, h: 0.3 });
    s.addText(t, { x: x + 0.78, y: 4.7, w: 4.2, h: 0.7, fontFace: FM, fontSize: 12.5, color: T.white, valign: "middle", margin: 0 });
  });
  card(s, MX, 5.8, CW, 0.82, { fill: T.tealInk, border: T.tealDk });
  s.addText([
    { text: "Let's talk.    ", options: { color: T.teal, bold: true } },
    { text: "Anh Dang   ·   anhdang@kinqsradio.com", options: { color: T.white } },
  ], { x: MX, y: 5.8, w: CW, h: 0.82, fontFace: FH, fontSize: 16, align: "center", valign: "middle", margin: 0 });

  await pres.writeFile({ fileName: "BrainRouter-Investor-Deck.pptx" });
  console.log("WROTE BrainRouter-Investor-Deck.pptx");
}
main().catch(e => { console.error(e); process.exit(1); });
