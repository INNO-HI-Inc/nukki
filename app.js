import { AutoModel, AutoProcessor, RawImage, env } from "https://esm.sh/@huggingface/transformers@3";
env.allowLocalModels = false;

const $ = (s) => document.querySelector(s);

/* ---------- 배경 프리셋 ---------- */
const BGS = [
  { id: "transparent", kind: "transparent" },
  { id: "white",  kind: "solid", color: "#ffffff" },
  { id: "gray",   kind: "solid", color: "#eef0f3" },
  { id: "ink",    kind: "solid", color: "#15171c" },
  { id: "peach",  kind: "linear", stops: ["#FFD3A5", "#FD6585"] },
  { id: "sky",    kind: "linear", stops: ["#4FACFE", "#00F2FE"] },
  { id: "lilac",  kind: "linear", stops: ["#A18CD1", "#FBC2EB"] },
  { id: "mint",   kind: "linear", stops: ["#43E97B", "#38F9D7"] },
  { id: "sunset", kind: "linear", stops: ["#FA709A", "#FEE140"] },
  { id: "indigo", kind: "linear", stops: ["#6A11CB", "#2575FC"] },
  { id: "ocean",  kind: "linear", stops: ["#0BA360", "#3CBA92"] },
  { id: "dusk",   kind: "linear", stops: ["#30cfd0", "#330867"] },
];
const cssFor = (b) =>
  b.kind === "solid" ? b.color :
  b.kind === "linear" ? `linear-gradient(135deg, ${b.stops[0]}, ${b.stops[1]})` : "";

const state = {
  file: null, origUrl: null, resultUrl: null, cutCanvas: null,
  bg: BGS[0], pad: 12, shadow: 45, round: 8, feather: 0, res: 768,
};

/* ---------- 엔진 (WebGPU+fp16 / WASM+q8) ---------- */
let model = null, device = null, dtype = null;
const procCache = new Map();
function setEngine() {
  const e = $("#engine");
  if (!device) { e.textContent = navigator.gpu ? "⚡ WebGPU 준비" : "WASM (CPU)"; return; }
  e.textContent = device === "webgpu" ? `⚡ WebGPU · ${dtype}` : `WASM · ${dtype}`;
  e.classList.toggle("gpu", device === "webgpu");
  // WASM이면 WebGPU 권장 안내
  if (device === "wasm") {
    const n = $("#engineNote"); n.classList.add("warn");
    n.innerHTML = "⚠️ 이 브라우저는 <b>WebGPU 미지원</b>이라 CPU로 느립니다. " +
      "<b>Chrome·Edge(데스크톱)</b>에서 열면 GPU로 훨씬 빨라져요. (또는 '빠름' 해상도 사용)";
  }
}
setEngine();

function getProcessor(size) {
  if (procCache.has(size)) return procCache.get(size);
  const p = AutoProcessor.from_pretrained("briaai/RMBG-1.4", {
    config: {
      do_normalize: true, do_pad: false, do_rescale: true, do_resize: true,
      image_mean: [0.5, 0.5, 0.5], image_std: [1, 1, 1], resample: 2,
      rescale_factor: 1 / 255, size: { width: size, height: size },
    },
  });
  procCache.set(size, p);
  return p;
}

async function ensureModel() {
  if (model) return;
  const prog = (p) => {
    if (p.status === "progress" && p.total) {
      const pct = Math.round((p.loaded / p.total) * 100);
      $("#progress").classList.remove("hidden");
      $("#bar").style.width = pct + "%";
      $("#busyMsg").textContent = `AI 모델 받는 중… ${pct}% (처음 한 번만)`;
    }
  };
  // 엔진 우선순위: WebGPU+fp16 → WebGPU+fp32 → WASM+q8
  const plans = navigator.gpu
    ? [["webgpu", "fp16"], ["webgpu", "fp32"], ["wasm", "q8"]]
    : [["wasm", "q8"]];
  for (const [dev, dt] of plans) {
    try {
      model = await AutoModel.from_pretrained("briaai/RMBG-1.4",
        { config: { model_type: "custom" }, device: dev, dtype: dt, progress_callback: prog });
      device = dev; dtype = dt; break;
    } catch (e) { console.warn("engine fail:", dev, dt, e?.message || e); }
  }
  if (!model) throw new Error("AI 모델을 불러오지 못했습니다");
  setEngine();
  $("#progress").classList.add("hidden");
  // WASM(CPU)이면 기본을 '빠름(512)'으로 (사용자가 직접 고르기 전까지)
  if (device === "wasm" && !state._resTouched) { state.res = 512; reflectRes(); }

  // 워밍업(WebGPU 셰이더 컴파일) — 첫 이미지가 느리지 않게
  try {
    $("#busyMsg").textContent = "엔진 준비 중…";
    const warm = new RawImage(new Uint8ClampedArray(64 * 64 * 3).fill(127), 64, 64, 3);
    const proc = await getProcessor(state.res);
    const { pixel_values } = await proc(warm);
    await model({ input: pixel_values });
  } catch (e) { /* 워밍업 실패는 무시 */ }
}

async function cutout(blobURL) {
  const image = await RawImage.fromURL(blobURL);
  const proc = await getProcessor(state.res);
  const { pixel_values } = await proc(image);
  const { output } = await model({ input: pixel_values });
  const mask = await RawImage.fromTensor(output[0].mul(255).to("uint8")).resize(image.width, image.height);

  const c = document.createElement("canvas");
  c.width = image.width; c.height = image.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(image.toCanvas(), 0, 0);
  const pd = ctx.getImageData(0, 0, c.width, c.height);
  const md = mask.data;
  for (let i = 0; i < md.length; i++) pd.data[4 * i + 3] = md[i];
  ctx.putImageData(pd, 0, 0);
  return c;
}

function featherCanvas(src, px) {
  if (px <= 0) return src;
  const w = src.width, h = src.height;
  const blur = document.createElement("canvas"); blur.width = w; blur.height = h;
  const bctx = blur.getContext("2d"); bctx.filter = `blur(${px}px)`; bctx.drawImage(src, 0, 0);
  const out = document.createElement("canvas"); out.width = w; out.height = h;
  const octx = out.getContext("2d");
  const sd = src.getContext("2d").getImageData(0, 0, w, h);
  const bd = bctx.getImageData(0, 0, w, h);
  for (let i = 0; i < w * h; i++) sd.data[4 * i + 3] = bd.data[4 * i + 3];
  octx.putImageData(sd, 0, 0);
  return out;
}
function showCut() {
  const c = featherCanvas(state.cutCanvas, state.feather);
  state.resultUrl = c.toDataURL("image/png");
  $("#subject").src = state.resultUrl;
}

/* ---------- 디바이스/배경 스와치 ---------- */
const swEl = $("#swatches");
BGS.forEach((b, i) => {
  const d = document.createElement("div");
  d.className = "sw" + (b.kind === "transparent" ? " checker" : "") + (i === 0 ? " on" : "");
  if (b.kind !== "transparent") d.style.background = cssFor(b);
  d.onclick = () => selectBG(b, d);
  swEl.appendChild(d);
});
function selectBG(b, el) {
  state.bg = b;
  swEl.querySelectorAll(".sw").forEach(x => x.classList.remove("on"));
  if (el) el.classList.add("on");
  paintBG();
}
$("#customColor").oninput = (e) => {
  $("#customDot").style.background = e.target.value;
  selectBG({ kind: "solid", color: e.target.value }, null);
};

/* ---------- 프리뷰 컨트롤 ---------- */
function paintBG() {
  const f = $("#frame");
  f.classList.toggle("checker", state.bg.kind === "transparent");
  f.style.background = state.bg.kind === "transparent" ? "" : cssFor(state.bg);
}
function paintFrame() {
  const f = $("#frame");
  f.style.padding = state.pad + "%";
  f.style.borderRadius = state.round + "%";
  const sh = state.shadow;
  $("#subject").style.filter = sh > 0
    ? `drop-shadow(0 ${(sh * 0.28).toFixed(0)}px ${(sh * 0.5).toFixed(0)}px rgba(0,0,0,${(sh / 100 * 0.5).toFixed(2)}))`
    : "none";
}
$("#pad").oninput = e => { state.pad = +e.target.value; $("#padVal").textContent = state.pad + "%"; paintFrame(); };
$("#shadow").oninput = e => { state.shadow = +e.target.value; $("#shVal").textContent = state.shadow; paintFrame(); };
$("#round").oninput = e => { state.round = +e.target.value; $("#rdVal").textContent = state.round + "%"; paintFrame(); };
$("#feather").oninput = e => {
  state.feather = +e.target.value; $("#featherVal").textContent = e.target.value;
  if (state.cutCanvas) showCut();
};

/* 처리 속도(해상도) */
function reflectRes() {
  $("#res").querySelectorAll("button").forEach(x =>
    x.classList.toggle("on", +x.dataset.r === state.res));
}
$("#res").querySelectorAll("button").forEach(b => b.onclick = () => {
  state.res = +b.dataset.r; state._resTouched = true; reflectRes();
  if (state.file) process();   // 해상도 변경 → 재처리
});

/* ---------- 업로드 ---------- */
const drop = $("#drop"), fileInput = $("#file");
drop.onclick = () => fileInput.click();
fileInput.onchange = () => fileInput.files[0] && loadFile(fileInput.files[0]);
["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("hot"); }));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("hot"); }));
drop.addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if (f) loadFile(f); });
window.addEventListener("paste", e => {
  const it = [...e.clipboardData.items].find(i => i.type.startsWith("image/"));
  if (it) loadFile(it.getAsFile());
});
["person", "product", "animal", "person2"].forEach(name => {
  const img = document.createElement("img");
  img.src = `samples/${name}.jpg`; img.alt = name; img.loading = "lazy";
  img.onclick = (e) => {
    e.stopPropagation();
    fetch(img.src).then(r => r.blob()).then(b => loadFile(new File([b], name + ".jpg", { type: "image/jpeg" })));
  };
  $("#samples").appendChild(img);
});

function loadFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  state.file = file;
  if (state.origUrl) URL.revokeObjectURL(state.origUrl);
  state.origUrl = URL.createObjectURL(file);
  process();
}

/* ---------- 처리 ---------- */
async function process() {
  $("#busy").classList.remove("hidden");
  $("#busyMsg").textContent = model ? "누끼 따는 중…" : "AI 모델 준비 중…";
  try {
    if (!model) await ensureModel();
    $("#busyMsg").textContent = "누끼 따는 중…";
    const t0 = performance.now();
    state.cutCanvas = await cutout(state.origUrl);
    showCut();
    $("#drop").classList.add("hidden");
    $("#shot").classList.remove("hidden");
    $("#download").disabled = false;
    $("#newImg").classList.remove("hidden");
    paintBG(); paintFrame();
    const ms = Math.round(performance.now() - t0);
    $("#stats").innerHTML = `엔진 <b>${device === "webgpu" ? "WebGPU" : "WASM"}</b> · ` +
      `<b>${state.cutCanvas.width}×${state.cutCanvas.height}</b> · 처리 <b>${(ms / 1000).toFixed(1)}s</b>`;
  } catch (e) {
    $("#busyMsg").textContent = "오류: " + (e?.message || e);
    $("#progress").classList.add("hidden");
    setTimeout(() => $("#busy").classList.add("hidden"), 3500);
    return;
  }
  $("#busy").classList.add("hidden");
}

/* ---------- 원본 비교 (누르고 있기) ---------- */
const cmp = $("#cmp");
cmp.addEventListener("mousedown", () => $("#subject").src = state.origUrl);
["mouseup", "mouseleave"].forEach(ev => cmp.addEventListener(ev, () => { if (state.resultUrl) $("#subject").src = state.resultUrl; }));

/* ---------- 새 이미지 ---------- */
$("#newImg").onclick = () => {
  $("#shot").classList.add("hidden");
  $("#drop").classList.remove("hidden");
  $("#download").disabled = true;
  $("#newImg").classList.add("hidden");
  state.file = null; state.resultUrl = null; state.cutCanvas = null;
};

/* ---------- 다운로드 (shot 합성) ---------- */
$("#download").onclick = () => {
  if (!state.resultUrl) return;
  const img = new Image();
  img.onload = () => {
    const W0 = img.naturalWidth, H0 = img.naturalHeight;
    const pad = Math.round(W0 * state.pad / 100);
    const W = W0 + pad * 2, H = H0 + pad * 2;
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const ctx = c.getContext("2d");
    const r = Math.min(W, H) * state.round / 100;
    if (state.bg.kind !== "transparent") {
      roundRect(ctx, 0, 0, W, H, r);
      if (state.bg.kind === "solid") ctx.fillStyle = state.bg.color;
      else {
        const g = ctx.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, state.bg.stops[0]); g.addColorStop(1, state.bg.stops[1]);
        ctx.fillStyle = g;
      }
      ctx.fill();
    }
    ctx.save();
    const sh = state.shadow;
    if (sh > 0) {
      ctx.shadowColor = `rgba(0,0,0,${sh / 100 * 0.5})`;
      ctx.shadowBlur = W0 * 0.05 * (sh / 100);
      ctx.shadowOffsetY = W0 * 0.025 * (sh / 100);
    }
    ctx.drawImage(img, pad, pad, W0, H0);
    ctx.restore();
    const a = document.createElement("a");
    a.href = c.toDataURL("image/png"); a.download = `nukki_${Date.now()}.png`; a.click();
  };
  img.src = state.resultUrl;
};
function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

paintFrame();
