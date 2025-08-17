// server.js — Orchestrator + 5 Alt Agent (sağlamlaştırılmış)

// -------------------- imports & setup --------------------
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "cross-fetch";
import dotenv from "dotenv";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "20mb" }));

const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR, { index: "index.html" }));

// -------------------- env & models --------------------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASEURL = process.env.OPENAI_BASEURL || "https://api.openai.com";

const MODEL_ORCHESTRATOR   = process.env.MODEL_ORCHESTRATOR   || "gpt-4.1-mini";   // "nano/mini" sınıf
const MODEL_PHARMACY       = process.env.MODEL_PHARMACY       || "gpt-4.1";  // eczacı
const MODEL_GENERAL_HEALTH = process.env.MODEL_GENERAL_HEALTH || "gpt-4.1";       // genel sağlık
const MODEL_SYMPTOM_OR_DRUG= process.env.MODEL_SYMPTOM_OR_DRUG|| "gpt-4.1-mini";
const MODEL_IMAGE          = process.env.MODEL_IMAGE          || "gpt-4o-mini";
const MODEL_PRICING        = process.env.MODEL_PRICING        || "gpt-4.1";
const MODEL_HTML_REWRITER  = process.env.MODEL_HTML_REWRITER  || "gpt-4.1-mini";

const DEBUG_FLAG = process.env.DEBUG === "1";

if (!OPENAI_API_KEY) {
  console.error("ERROR: OPENAI_API_KEY .env içinde yok!");
  process.exit(1);
}

// -------------------- helpers --------------------
function extractTextFromResponses(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text;
  const bucket = [];
  const walk = (x) => {
    if (!x) return;
    if (typeof x === "string") { bucket.push(x); return; }
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (typeof x === "object") {
      if (typeof x.text === "string") bucket.push(x.text);
      if (x.text?.value && typeof x.text.value === "string") bucket.push(x.text.value);
      if (Array.isArray(x.content)) x.content.forEach(walk);
      if (Array.isArray(x.output))  x.output.forEach(walk);
      for (const k of Object.keys(x)) {
        if (k !== "content" && k !== "output" && k !== "text") walk(x[k]);
      }
    }
  };
  walk(data);
  return bucket.join("\n").trim();
}

async function callOpenAI(payload, label = "openai") {
  const r = await fetch(`${OPENAI_BASEURL}/v1/responses`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const raw = await r.text();
  if (DEBUG_FLAG) {
    console.log(`[${label}] status:`, r.status, r.statusText);
    console.log(`[${label}] raw (first 1500):\n`, raw.slice(0, 1500));
  }
  if (!r.ok) {
    const err = new Error(`OpenAI error ${r.status}`);
    err.detail = raw.slice(0, 1500);
    throw err;
  }
  let data = null;
  try { data = JSON.parse(raw); } catch {
    const err = new Error("OpenAI yanıtı JSON değil");
    err.detail = raw.slice(0, 1000);
    throw err;
  }
  return { data, text: extractTextFromResponses(data), raw };
}

// Responses API tool_call çıkarıcı
function findFirstToolCall(data) {
  const dfs = (node) => {
    if (!node) return null;
    if (Array.isArray(node)) {
      for (const el of node) {
        const r = dfs(el);
        if (r) return r;
      }
      return null;
    }
    if (typeof node === "object") {
      if (node.type === "tool_call" && node.name) {
        let args = node.arguments;
        if (typeof args === "string") {
          try { args = JSON.parse(args); } catch { /* ignore */ }
        }
        return { name: node.name, arguments: args || {} };
      }
      for (const k of Object.keys(node)) {
        const r = dfs(node[k]);
        if (r) return r;
      }
    }
    return null;
  };
  return dfs(data);
}

function nowTRISO() {
  return new Date().toISOString(); // TR bilgisini metinle iletiyoruz
}

// -------------------- PROMPTS --------------------
const HTML_REWRITER_SYSTEM_PROMPT = `
SEN: Bir "HTML Rewriter" olarak çalışıyorsun. Görevin, verilen metni veya kısmi HTML'i
(gerekliyse) yeniden yapılandırarak TEK bir kök <section> elemanı içinde *tamamen* HTML
FRAGMANI olarak döndürmektir.
KURALLAR:
- Güvenli HTML (script/style/iframe/event handler yok).
- Anlamlı başlık hiyerarşisi; listeler/tablolar/linkleri koru.
- Inline CSS ekleme; sadece semantik HTML.
- Tek bir kök <section class="agent-output"> kullan.
- İçeriğin dilini koru.
- Bu tarz agent çıktılarını ve kendi bu tarz çıktıarını her zaman kaldır:"output_text msg_68a1b6d4286081958b315bcb9f66f73e0129b45d3880a25d message completed assistant resp_68a1b6d3d93081958b45631c9a5a0f770129b45d3880a25d response completed gpt-4.1-mini-2025-04-14 default auto disabled"
ÇIKTI: Yalnızca <section class="agent-output"> ... </section>.
`.trim();

const ORCHESTRATOR_SYSTEM_PROMPT = `
SEN: "Orchestrator" ajanısın. Görevin, kullanıcının girdisini YALNIZCA bir alt ajana yönlendirmektir.
- Normal metin üretme. SADECE uygun "function call" yap.
- Görsel varsa: route_to_image_agent.
- "nöbetçi eczane / eczane / açık eczane": route_to_pharmacy.
- "fiyat, ne kadar, ücreti, maliyet, fiyatlandırma": route_to_pricing.
- İlaç/etken/yan etki/doz/kontrendikasyon: route_to_symptom_or_drug + mode="drug".
- Şikâyet (başım ağrıyor, öksürük vb.): route_to_symptom_or_drug + mode="symptom".
- Yaşam tarzı (koşu, kalori, uyku...): route_to_general_health.
- Profil/konum/zaman metinleri ipucu olarak iletilmiştir.
Her zaman TEK bir function çağır.
`.trim();

const PHARMACY_AGENT_SYSTEM_PROMPT = `
SEN: "Pharmacy" ajanısın. Bugüne ait nöbetçi eczaneleri (Europe/Istanbul) il/ilçeye göre listeleyeceksin.
- Güvenilir kaynaklar: "https://eczaneler.org/<kullanıcının girdiği il>-<kullanıcının girdiği ilçe>-nobetci-eczaneleri". Kullanıcının istediği il/ilçe bilgilerini kullan ve url'in sonuna ekle. örneğin kullanıcı istanbul avcılar diyorsa url şöyle olmalı: "https://eczaneler.org/istanbul-avcilar-nobetci-eczaneleri". kullanıcı kadıköy diyorsa url şöyle olmalı: "https://eczaneler.org/istanbul-kadikoy-nobetci-eczaneleri". yani "https://eczaneler.org/il-ilce-nobetci-eczaneleri".
- Url linkini tamamladıktan sonra, url'de bulunan eczaneleri listele ve sadece bu eczanelerin bilgilerini çıkar.
- Çıktı: Özet; Nöbetçi Eczaneler (Ad, Adres, Telefon, İl/İlçe, Mesai, harita linki?); Kaynaklar (Son erişim: YYYY-AA-GG).
- Son not: “Bu içerik bilgilendirme amaçlıdır; kişisel sağlık kararlarınız için doktorunuza danışın.Hangi siteden kaynak aldığını belirt, url linkini kullanıcıyla paylaş.”
`.trim();

const SYMPTOM_OR_DRUG_AGENT_SYSTEM_PROMPT = `
SEN: "Şikâyet/İlaç" ajanısın. Güvenilir kaynaklarla yapılandırılmış TR içeriği üret. İlk başta kullanıcının rahatsızlığını da kısaca tanıt.
- Şikâyet akışı: Özet; Kırmızı Bayraklar; Olası Nedenler; Kendi Kendine Bakım; Uygun OTC Sınıfları; Uyarılar; Kaynaklar.
- İlaç akışı (prospektüs özeti): Endikasyonlar; Doz; Uyarılar; Etkileşimler; Advers etkiler; Kontrendikasyonlar; vb.
- Reçeteli isim verme. TR bağlamı ve TL kullan.
- Son not zorunlu.
`.trim();

const GENERAL_HEALTH_AGENT_SYSTEM_PROMPT = `
SEN: "Genel Sağlık" ajanısın. WHO/CDC/NHS'e dayalı, düşük riskli ve kademeli yaşam tarzı önerileri ver.
- Gerekirse 1 haftalık basit plan.
- Uygun uyarılar ve son not.
`.trim();

const IMAGE_AGENT_SYSTEM_PROMPT = `
SEN: "İlaç Görseli" ajanısın. Yüklenen kutu/etiketten ürün adı, etken, form, doz vb. güvenle ayrılabilen bilgileri çıkar.
Emin olmadıklarını belirt. Uzun prospektif özet + “Doktorunuza danışın.” uyarısı ekle. İlacın neden kullanıldığını ve yan etkilerini açıkça belirt.
`.trim();

const PRICING_AGENT_SYSTEM_PROMPT = `
SEN: "Fiyatlandırma" ajanısın. TR'de güncel TL fiyat aralığı + Toplam Tahmini Maliyet çıkar. Kaynakları listele.
Bulamazsan sebebiyle birlikte belirt.
`.trim();

// -------------------- TOOLS (flat Responses API function schema) --------------------
const ORCHESTRATOR_TOOLS = [
  {
    type: "function",
    name: "route_to_pharmacy",
    description: "Nöbetçi eczane sorgusu için yönlendir.",
    parameters: {
      type: "object",
      properties: {
        query:    { type: "string" },
        city:     { type: "string" },
        district: { type: "string" }
      },
      required: ["query"]
    }
  },
  {
    type: "function",
    name: "route_to_general_health",
    description: "Genel sağlık/yaşam tarzı için yönlendir.",
    parameters: {
      type: "object",
      properties: {
        query:   { type: "string" },
        profile: { type: "object" }
      },
      required: ["query"]
    }
  },
  {
    type: "function",
    name: "route_to_image_agent",
    description: "İlaç görseli/etiketi analizi için yönlendir.",
    parameters: {
      type: "object",
      properties: {
        note: { type: "string" }
      }
    }
  },
  {
    type: "function",
    name: "route_to_symptom_or_drug",
    description: "Şikâyet veya ilaç/etken işleme ajanı.",
    parameters: {
      type: "object",
      properties: {
        mode:    { type: "string", enum: ["symptom", "drug"] },
        query:   { type: "string" },
        profile: { type: "object" }
      },
      required: ["mode", "query"]
    }
  },
  {
    type: "function",
    name: "route_to_pricing",
    description: "Fiyatlandırma ajanına yönlendir.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name:     { type: "string" },
              form:     { type: "string" },
              strength: { type: "string" },
              pack:     { type: "string" },
              qty:      { type: "number" }
            },
            required: ["name"]
          }
        },
        query: { type: "string" }
      }
    }
  }
];

// -------------------- ALT AGENT ÇAĞIRICILAR --------------------
async function runPharmacyAgent({ query, city, district, t }) {
  console.log("[pharmacy] running...");
  const user = `Sorgu: ${query}\nİl: ${city || "-"} | İlçe: ${district || "-"}\nZaman: ${t || nowTRISO()} (Europe/Istanbul)`;

  // 1) web_search ile dene
  const payloadWithWeb = {
    model: MODEL_PHARMACY,
    input: [
      { role: "system", content: [{ type: "input_text", text: PHARMACY_AGENT_SYSTEM_PROMPT }] },
      { role: "user",   content: [{ type: "input_text", text: user }] }
    ],
    tools: [{ type: "web_search" }],
    tool_choice: "auto"
  };

  try {
    const r = await callOpenAI(payloadWithWeb, "pharmacy(web)");
    return r.text;
  } catch (e) {
    // Eğer hesapta web_search yoksa retry yap
    const detail = String(e?.detail || "");
    if (detail.includes("web_search") || detail.includes("tool") || /invalid/i.test(detail)) {
      console.warn("[pharmacy] web_search başarısız, araçsız tekrar deniyorum...");
      const payloadNoWeb = {
        model: MODEL_PHARMACY,
        input: [
          { role: "system", content: [{ type: "input_text", text: PHARMACY_AGENT_SYSTEM_PROMPT }] },
          { role: "user",   content: [{ type: "input_text", text: user }] }
        ]
      };
      const r2 = await callOpenAI(payloadNoWeb, "pharmacy(no-web)");
      return r2.text;
    }
    throw e;
  }
}

async function runSymptomOrDrugAgent({ mode, query, profile, t }) {
  console.log("[symptom_or_drug] running...");
  const hint = `Mod: ${mode}\nProfil: ${profile ? JSON.stringify(profile) : "(yok)"}\nZaman: ${t || nowTRISO()} (Europe/Istanbul)`;
  const payload = {
    model: MODEL_SYMPTOM_OR_DRUG,
    input: [
      { role: "system", content: [{ type: "input_text", text: SYMPTOM_OR_DRUG_AGENT_SYSTEM_PROMPT }] },
      { role: "user",   content: [{ type: "input_text", text: query }] },
      { role: "user",   content: [{ type: "input_text", text: hint }] }
    ]
  };
  const r = await callOpenAI(payload, "symptom_or_drug");
  return r.text;
}

async function runGeneralHealthAgent({ query, profile, t }) {
  console.log("[general_health] running...");
  const hint = `Profil: ${profile ? JSON.stringify(profile) : "(yok)"}\nZaman: ${t || nowTRISO()} (Europe/Istanbul)`;
  const payload = {
    model: MODEL_GENERAL_HEALTH,
    input: [
      { role: "system", content: [{ type: "input_text", text: GENERAL_HEALTH_AGENT_SYSTEM_PROMPT }] },
      { role: "user",   content: [{ type: "input_text", text: query }] },
      { role: "user",   content: [{ type: "input_text", text: hint }] }
    ]
  };
  const r = await callOpenAI(payload, "general_health");
  return r.text;
}

async function runImageAgent({ note, image, t }) {
  console.log("[image_agent] running...");
  const content = [{ type: "input_text", text: note || "İlaç görseli analizi" }];
  if (typeof image === "string" && image.startsWith("data:image/")) {
    content.push({ type: "input_image", image_url: image });
  }
  content.push({ type: "input_text", text: `Zaman: ${t || nowTRISO()} (Europe/Istanbul)` });
  const payload = {
    model: MODEL_IMAGE,
    input: [
      { role: "system", content: [{ type: "input_text", text: IMAGE_AGENT_SYSTEM_PROMPT }] },
      { role: "user",   content }
    ]
  };
  const r = await callOpenAI(payload, "image_agent");
  return r.text;
}

async function runPricingAgent({ items, query, t }) {
  console.log("[pricing] running...");
  const body = [
    `Sorgu: ${query || "(yok)"}`,
    `Ürün Listesi: ${items && items.length ? JSON.stringify(items) : "(liste yok — adı geçenlerden ara)"}`,
    `Zaman: ${t || nowTRISO()} (Europe/Istanbul)`
  ].join("\n");
  const payload = {
    model: MODEL_PRICING,
    input: [
      { role: "system", content: [{ type: "input_text", text: PRICING_AGENT_SYSTEM_PROMPT }] },
      { role: "user",   content: [{ type: "input_text", text: body }] }

    ],
    tools: [{ type: "web_search" }],
    tool_choice: "auto"
  };
  const r = await callOpenAI(payload, "pricing");
  return r.text;
}

// -------------------- DIAG --------------------
app.get("/api/_diag", async (req, res) => {
  try {
    const body = {
      model: MODEL_ORCHESTRATOR,
      input: [{ role: "user", content: [{ type: "input_text", text: "Sadece 'Merhaba' yaz." }] }]
    };
    const { text, raw } = await callOpenAI(body, "_diag");
    res.json({ ok: true, status: 200, text, raw: raw.slice(0, 1000) });
  } catch (e) {
    console.error("[_diag] HATA:", e, e?.detail);
    res.status(500).json({ ok:false, error:String(e), detail:e?.detail });
  }
});

// -------------------- LOCAL FALLBACK ROUTER --------------------
function localRouteHeuristic({ text, hasImage }) {
  const t = (text || "").toLowerCase();

  if (hasImage) return { name: "route_to_image_agent", arguments: {} };

  if (/(nöbetçi|eczane|açık eczane)/.test(t)) {
    return { name: "route_to_pharmacy", arguments: {} };
  }
  if (/(fiyat|ne kadar|ücret|maliyet|fiyatlandır)/.test(t)) {
    return { name: "route_to_pricing", arguments: {} };
  }
  if (/(başım ağrıyor|ağrı|öksürük|ateş|bulantı|ishal|kabız|nezle|grip|kaşıntı)/.test(t)) {
    return { name: "route_to_symptom_or_drug", arguments: { mode: "symptom" } };
  }
  // kabaca ilaç ismi/etken madde yakalama
  if (/\b(\w{3,})\b/.test(t) && /(mg|tablet|kapsül|şurup|etken|prospektüs)/.test(t)) {
    return { name: "route_to_symptom_or_drug", arguments: { mode: "drug" } };
  }
  // default: genel sağlık
  return { name: "route_to_general_health", arguments: {} };
}

// -------------------- ANA ENDPOINT (ORCHESTRATION) --------------------
app.post("/api/agent-search", async (req, res) => {
  const isDebug = DEBUG_FLAG || req.query.debug === "1";
  try {
    const { q, image, t, profile, city, district, items } = req.body || {};
    const text = (q || "").toString().trim();
    const hasImage = typeof image === "string" && image.startsWith("data:image/");

    if (!text && !hasImage) {
      return res.status(400).json({ ok:false, error:"Geçersiz girdi: metin veya görsel gerekli." });
    }

    // 1) ORCHESTRATOR çağrısı
    const userContent = [];
    if (text) userContent.push({ type: "input_text", text });
    if (hasImage) userContent.push({ type: "input_image", image_url: image });
    userContent.push({ type: "input_text", text: `Profil: ${profile ? JSON.stringify(profile) : "(yok)"}` });
    userContent.push({ type: "input_text", text: `Konum: ${city || "-"} / ${district || "-"}` });
    userContent.push({ type: "input_text", text: `Zaman: ${t || nowTRISO()} (Europe/Istanbul)` });

    const orchestratorPayload = {
      model: MODEL_ORCHESTRATOR,
      input: [
        { role: "system", content: [{ type: "input_text", text: ORCHESTRATOR_SYSTEM_PROMPT }] },
        { role: "user",   content: userContent }
      ],
      tools: ORCHESTRATOR_TOOLS,
      tool_choice: "auto"
    };

    console.log("[orchestrator] calling...");
    let route = null;
    try {
      const orchestratorResp = await callOpenAI(orchestratorPayload, "orchestrator");
      route = findFirstToolCall(orchestratorResp.data);
      if (isDebug) console.log("[orchestrator] raw route:", route);
    } catch (e) {
      console.error("[orchestrator] HATA:", e, "\nDETAIL:", e?.detail);
    }

    // 1b) Fallback router
    if (!route) {
      console.warn("[router] Orchestrator yönlendirme üretemedi, yerel heuristics devrede.");
      route = localRouteHeuristic({ text, hasImage });
      if (isDebug) console.log("[router] local decision:", route);
    }

    // 2) Seçilen ALT AGENT çağrısı
    let agentOutput = "";
    switch (route.name) {
      case "route_to_pharmacy":
        agentOutput = await runPharmacyAgent({
          query: text,
          city: route.arguments?.city || city,
          district: route.arguments?.district || district,
          t
        });
        break;

      case "route_to_general_health":
        agentOutput = await runGeneralHealthAgent({
          query: text,
          profile: route.arguments?.profile || profile,
          t
        });
        break;

      case "route_to_image_agent":
        agentOutput = await runImageAgent({
          note: route.arguments?.note || "İlaç görseli analizi",
          image,
          t
        });
        break;

      case "route_to_symptom_or_drug":
        agentOutput = await runSymptomOrDrugAgent({
          mode: route.arguments?.mode || "symptom",
          query: text,
          profile: route.arguments?.profile || profile,
          t
        });
        break;

      case "route_to_pricing":
        agentOutput = await runPricingAgent({
          items: route.arguments?.items || items,
          query: text,
          t
        });
        break;

      default:
        console.warn(`[router] Bilinmeyen yönlendirme: ${route.name}, genel sağlığa düşüyorum.`);
        agentOutput = await runGeneralHealthAgent({ query: text, profile, t });
    }

    if (!agentOutput || !agentOutput.trim()) {
      return res.status(502).json({ ok:false, error:"Alt agent çıktı üretemedi (boş)." });
    }

    // 3) HTML REWRITER
    console.log("[html_rewriter] running...");
    const rewriterUser = `
Aşağıdaki içeriği güvenli, tek köklü bir <section class="agent-output"> HTML fragmanı olarak yeniden yaz.

--- BAŞLA ---
${agentOutput}
--- BİTİR ---
`.trim();

    const rewriterPayload = {
      model: MODEL_HTML_REWRITER,
      input: [
        { role: "system", content: [{ type: "input_text", text: HTML_REWRITER_SYSTEM_PROMPT }] },
        { role: "user",   content: [{ type: "input_text", text: rewriterUser }] }
      ]
    };

    const rewriterResp = await callOpenAI(rewriterPayload, "rewriter");
    const finalHtml = rewriterResp.text?.trim() || agentOutput;

    return res.json({
      ok: true,
      html: finalHtml,
      ...(isDebug ? { routing: route } : {})
    });

  } catch (e) {
    console.error("[agent-search] HATA:", e, "\nDETAIL:", e?.detail);
    return res.status(500).json({ ok:false, error:String(e), detail:e?.detail });
  }
});

// -------------------- SPA fallback --------------------
app.get("*", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// -------------------- listen --------------------
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`İlaç Agent lokal sunucu hazır: http://localhost:${PORT}`);
  console.log(`Statik dizin: ${PUBLIC_DIR}`);
  console.log(`Debug: ${DEBUG_FLAG ? "AÇIK" : "kapalı"} | Tools: eczane ajanı web_search (otomatik retry-off)`);
  console.log(`Models -> orchestrator:${MODEL_ORCHESTRATOR} | pharmacy:${MODEL_PHARMACY} | general_health:${MODEL_GENERAL_HEALTH} | symptom_or_drug:${MODEL_SYMPTOM_OR_DRUG} | image:${MODEL_IMAGE} | pricing:${MODEL_PRICING} | rewriter:${MODEL_HTML_REWRITER}`);
});
