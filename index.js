const express = require("express");
const twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const USUARIO_MAMA = "usuario_mama";

const NUMERO_MAMA = process.env.NUMERO_MAMA ? process.env.NUMERO_MAMA.trim() : "";

const CATEGORIAS = [
  "Supermercado","Combustible y viáticos","Gastos Impuestos Casa",
  "Mantenimiento casa","Sueldo Luis","Sueldo empleada","Regalos","Ropa",
  "Eventual","Perras","Salidas y Pedidos","Compras","Jardín",
  "Entretenimiento","Salud y Farmacia","Vehículos","Inversión Casa Obra",
  "Vacaciones","Otros"
];

const DB_PATH = process.env.DB_PATH || "./mamifin.db";
const DB_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS gastos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario TEXT NOT NULL,
    descripcion TEXT NOT NULL,
    monto REAL NOT NULL,
    categoria TEXT NOT NULL,
    fecha TEXT NOT NULL,
    nota TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS ingresos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario TEXT NOT NULL,
    descripcion TEXT NOT NULL,
    monto REAL NOT NULL,
    fecha TEXT NOT NULL,
    nota TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS presupuestos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario TEXT NOT NULL,
    categoria TEXT NOT NULL,
    limite REAL NOT NULL,
    UNIQUE(usuario, categoria)
  );
  CREATE TABLE IF NOT EXISTS sesiones (
    usuario TEXT PRIMARY KEY,
    historial TEXT DEFAULT '[]',
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const TWILIO_NUMBER = process.env.TWILIO_NUMBER || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");

// ── REINTENTO AUTOMÁTICO ANTHROPIC ────────────────────────────────────────────
async function llamarAnthropic(params, intentos = 3) {
  for (let i = 0; i < intentos; i++) {
    try {
      return await anthropic.messages.create(params);
    } catch (e) {
      const sobrecargado = e?.error?.type === "overloaded_error" || e?.status === 529 || (e?.message||"").includes("overloaded");
      const ultimo = i === intentos - 1;
      if (sobrecargado && !ultimo) {
        const espera = (i + 1) * 2000;
        console.log(`⚠️ Anthropic sobrecargado, reintentando en ${espera/1000}s... (${i+1}/${intentos})`);
        await new Promise(r => setTimeout(r, espera));
      } else {
        throw e;
      }
    }
  }
}

// ── TIPO DE CAMBIO BROU ───────────────────────────────────────────────────────
let tcCache = { valor: null, fecha: null };

async function getTipoCambioBROU() {
  const ahora = new Date();
  if (tcCache.valor && tcCache.fecha && (ahora - tcCache.fecha) < 60*60*1000) return tcCache.valor;
  try {
    const resp = await fetch("https://cotizaciones.brou.com.uy/api/cotizaciones/dolar");
    const data = await resp.json();
    if (data) {
      const compra = parseFloat(data.compra || data.buy || 0);
      const venta = parseFloat(data.venta || data.sell || 0);
      if (compra > 0 && venta > 0) {
        const tc = (compra + venta) / 2;
        tcCache = { valor: tc, fecha: ahora };
        console.log(`TC BROU: $${tc.toFixed(2)} UYU/USD`);
        return tc;
      }
    }
    throw new Error("Respuesta inválida");
  } catch (e) {
    console.error("Error API BROU:", e.message);
    try {
      const resp2 = await fetch("https://open.er-api.com/v6/latest/USD");
      const data2 = await resp2.json();
      if (data2?.rates?.UYU) {
        const tc = data2.rates.UYU;
        tcCache = { valor: tc, fecha: ahora };
        return tc;
      }
    } catch (e2) { console.error("Error fallback TC:", e2.message); }
    return null;
  }
}

// ── HELPERS DB ────────────────────────────────────────────────────────────────
function getHistorial(usuario) {
  const row = db.prepare("SELECT historial FROM sesiones WHERE usuario = ?").get(usuario);
  return row ? JSON.parse(row.historial) : [];
}

function saveHistorial(usuario, historial) {
  const reciente = historial.slice(-20);
  db.prepare(`INSERT INTO sesiones (usuario, historial, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(usuario) DO UPDATE SET historial = excluded.historial, updated_at = excluded.updated_at
  `).run(usuario, JSON.stringify(reciente));
}

function getGastosMes(usuario) {
  const ahora = new Date();
  const patron = `${ahora.getFullYear()}-${String(ahora.getMonth()+1).padStart(2,"0")}-%`;
  return db.prepare("SELECT * FROM gastos WHERE usuario = ? AND fecha LIKE ? ORDER BY fecha ASC").all(usuario, patron);
}

function getIngresosMes(usuario) {
  const ahora = new Date();
  const patron = `${ahora.getFullYear()}-${String(ahora.getMonth()+1).padStart(2,"0")}-%`;
  return db.prepare("SELECT * FROM ingresos WHERE usuario = ? AND fecha LIKE ? ORDER BY fecha ASC").all(usuario, patron);
}

function getPresupuestos(usuario) {
  return db.prepare("SELECT * FROM presupuestos WHERE usuario = ?").all(usuario);
}

function getUltimosGastos(usuario, limite = 8) {
  return db.prepare("SELECT * FROM gastos WHERE usuario = ? ORDER BY created_at DESC LIMIT ?").all(usuario, limite);
}

function fmt(n) { return Math.round(n).toLocaleString("es-UY"); }

// ── CSV ───────────────────────────────────────────────────────────────────────
function generarYGuardarCSV(usuario, mes, anio) {
  let gastos, ingresos;
  if (!mes && !anio) {
    gastos = db.prepare("SELECT * FROM gastos WHERE usuario = ? ORDER BY fecha ASC").all(usuario);
    ingresos = db.prepare("SELECT * FROM ingresos WHERE usuario = ? ORDER BY fecha ASC").all(usuario);
  } else {
    const patron = `${anio}-${String(mes).padStart(2,"0")}-%`;
    gastos = db.prepare("SELECT * FROM gastos WHERE usuario = ? AND fecha LIKE ? ORDER BY fecha ASC").all(usuario, patron);
    ingresos = db.prepare("SELECT * FROM ingresos WHERE usuario = ? AND fecha LIKE ? ORDER BY fecha ASC").all(usuario, patron);
  }
  if (!gastos || gastos.length === 0) return null;

  const catTotals = {};
  gastos.forEach(g => { catTotals[g.categoria] = (catTotals[g.categoria]||0) + g.monto; });
  const totalGastos = gastos.reduce((s,g) => s+g.monto, 0);
  const totalIngresos = ingresos.reduce((s,i) => s+i.monto, 0);
  const saldo = totalIngresos - totalGastos;

  const bom = "\uFEFF";
  const csv = bom +
    "GASTOS\nID,Fecha,Descripción,Monto (UYU),Categoría,Nota\n" +
    gastos.map(g => `${g.id},${g.fecha},"${(g.descripcion||"").replace(/"/g,'""')}",${g.monto.toFixed(2)},"${g.categoria}","${(g.nota||"").replace(/"/g,'""')}"`).join("\n") +
    "\n\nINGRESOS\nID,Fecha,Descripción,Monto (UYU),Nota\n" +
    (ingresos.length > 0 ? ingresos.map(i => `${i.id},${i.fecha},"${(i.descripcion||"").replace(/"/g,'""')}",${i.monto.toFixed(2)},"${(i.nota||"").replace(/"/g,'""')}"`).join("\n") : "(sin ingresos)") +
    "\n\nRESUMEN POR CATEGORÍA\nCategoría,Total (UYU)\n" +
    Object.entries(catTotals).sort((a,b)=>b[1]-a[1]).map(([c,v])=>`"${c}",${v.toFixed(2)}`).join("\n") +
    `\n\nTOTAL GASTOS,${totalGastos.toFixed(2)}` +
    `\nTOTAL INGRESOS,${totalIngresos.toFixed(2)}` +
    `\nSALDO NETO,${saldo.toFixed(2)}`;

  const hoy = new Date().toISOString().split("T")[0];
  const nombre = (!mes&&!anio) ? `mamifin_historico_${hoy}.csv` : `mamifin_${anio}_${String(mes).padStart(2,"0")}.csv`;
  const dir = path.join(DB_DIR, "reportes");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, nombre), csv, "utf8");

  return { nombreArchivo: nombre, totalGastos, totalIngresos, saldo, catTotals, cantidad: gastos.length };
}

app.get("/reportes/:archivo", (req, res) => {
  const archivo = req.params.archivo;
  if (!archivo.startsWith("mamifin_") || !archivo.endsWith(".csv")) return res.status(403).send("Acceso denegado");
  const filePath = path.join(DB_DIR, "reportes", archivo);
  if (!fs.existsSync(filePath)) return res.status(404).send("Archivo no encontrado. Pedí el reporte de nuevo.");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${archivo}"`);
  fs.createReadStream(filePath).pipe(res);
});

// ── DETECCIÓN DE REPORTE ──────────────────────────────────────────────────────
function esReporte(t) {
  const s = t.toLowerCase();
  return s.includes("reporte")||s.includes("excel")||s.includes("csv")||s.includes("exportar")||s.includes("descargar")||s.includes("bajame");
}
function esMesEspecifico(t) {
  const meses = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
  const s = t.toLowerCase();
  for (let i = 0; i < meses.length; i++) if (s.includes(meses[i])) return { mes: i+1, anio: new Date().getFullYear() };
  return null;
}
function esHistoricoTexto(t) {
  const s = t.toLowerCase();
  return s.includes("histórico")||s.includes("historico")||s.includes("completo");
}
function respuestaReporte(usuario, mes, anio, labelMes) {
  const r = generarYGuardarCSV(usuario, mes, anio);
  if (!r) return `📊 No hay gastos para ${labelMes}.`;
  const top5 = Object.entries(r.catTotals).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const lineas = top5.map(([c,v])=>`  • ${c}: $${fmt(v)}`).join("\n");
  const mas = Object.keys(r.catTotals).length>5?"\n  ...":"";
  const saldoIcono = r.saldo >= 0 ? "🟢" : "🔴";
  const ingresoLinea = r.totalIngresos > 0 ? `\n💵 Ingresos: $${fmt(r.totalIngresos)} UYU\n${saldoIcono} Saldo: $${fmt(r.saldo)} UYU` : "";
  const link = PUBLIC_URL ? `\n\n📎 Descargá el CSV:\n${PUBLIC_URL}/reportes/${r.nombreArchivo}` : "";
  return `📊 *Reporte ${labelMes}*\n\n${lineas}${mas}\n\n💳 Gastos: $${fmt(r.totalGastos)} UYU${ingresoLinea}\n(${r.cantidad} transacciones)${link}`;
}

// ── CONTEXTO IA ───────────────────────────────────────────────────────────────
function buildContexto(usuario) {
  const gastosMes = getGastosMes(usuario);
  const ingresosMes = getIngresosMes(usuario);
  const presupuestos = getPresupuestos(usuario);
  const totalGastos = gastosMes.reduce((s,g)=>s+g.monto,0);
  const totalIngresos = ingresosMes.reduce((s,i)=>s+i.monto,0);
  const saldo = totalIngresos - totalGastos;
  const ultimos = getUltimosGastos(usuario,8);
  const catTotals = {};
  gastosMes.forEach(g=>{catTotals[g.categoria]=(catTotals[g.categoria]||0)+g.monto;});
  const presMap = {};
  presupuestos.forEach(p=>{presMap[p.categoria]=p.limite;});
  const excedidos = Object.keys(presMap).filter(c=>(catTotals[c]||0)>presMap[c]);
  const nombreMes = new Date().toLocaleDateString("es-UY",{month:"long",year:"numeric"});

  return `Eres MamiFin, asistente personal de finanzas de una señora uruguaya que vive sola. Respondés en español rioplatense, con tono amable y cercano, conciso (máximo 4 líneas). Emojis con moderación.

MONEDA: Todo se guarda en PESOS URUGUAYOS (UYU). Si el usuario menciona dólares, USD, U$S o $U, usá moneda "USD". Por defecto "UYU".

CATEGORÍAS GASTOS: ${CATEGORIAS.join(", ")}

HERRAMIENTAS — respondé SOLO con JSON exacto sin texto extra:
{"accion":"registrar","descripcion":"...","monto":0.00,"moneda":"UYU","categoria":"...","nota":"..."}
{"accion":"registrar_ingreso","descripcion":"...","monto":0.00,"moneda":"UYU","nota":"..."}
{"accion":"resumen"}
{"accion":"saldo"}
{"accion":"ver_ingresos"}
{"accion":"eliminar_ultimo_ingreso"}
{"accion":"presupuestos"}
{"accion":"guardar_presupuesto","categoria":"...","limite":0.00}
{"accion":"eliminar_ultimo"}
{"accion":"ver_ultimos"}
{"accion":"eliminar_id","id":123}
{"accion":"cambiar_categoria","id":123,"categoria":"..."}
{"accion":"texto","mensaje":"..."}

DATOS (${nombreMes}):
- Total gastos: $${fmt(totalGastos)} UYU
- Total ingresos: $${fmt(totalIngresos)} UYU
- Saldo neto: $${fmt(saldo)} UYU ${saldo>=0?"🟢":"🔴"}
- Gastos por categoría: ${JSON.stringify(catTotals)}
- Presupuestos: ${JSON.stringify(presMap)}
- Excedidos: ${excedidos.join(", ")||"ninguno"}
- Últimos 8 gastos: ${JSON.stringify(ultimos.map(g=>({id:g.id,desc:g.descripcion,monto:g.monto,cat:g.categoria,fecha:g.fecha})))}
- Últimos 3 ingresos: ${JSON.stringify(ingresosMes.slice(-3).map(i=>({id:i.id,desc:i.descripcion,monto:i.monto,fecha:i.fecha})))}

NUNCA uses acción reporte_csv — los reportes se manejan automáticamente.`;
}

// ── EJECUTAR ACCION ───────────────────────────────────────────────────────────
async function ejecutarAccion(usuario, accion) {
  const hoy = new Date().toISOString().split("T")[0];
  const ahora = new Date();

  if (accion.accion === "registrar") {
    const { descripcion, categoria, nota } = accion;
    let monto = parseFloat(accion.monto);
    const moneda = (accion.moneda || "UYU").toUpperCase();
    if (!descripcion || !monto || !categoria) return "❌ Faltan datos para registrar el gasto.";

    if (moneda === "USD") {
      const tc = await getTipoCambioBROU();
      if (!tc) return "⚠️ No pude obtener el TC del BROU. Intentá de nuevo o cargá el monto en pesos.";
      const montoUYU = Math.round(monto * tc);
      const notaFinal = `USD ${monto.toFixed(2)} × TC $${tc.toFixed(2)}${nota ? " | "+nota : ""}`;
      db.prepare("INSERT INTO gastos (usuario, descripcion, monto, categoria, fecha, nota) VALUES (?, ?, ?, ?, ?, ?)").run(usuario, descripcion, montoUYU, categoria, hoy, notaFinal);
      return `✅ Gasto registrado!\n📝 ${descripcion}\n💵 U$S ${monto.toFixed(2)} × TC $${tc.toFixed(2)}\n💰 $${fmt(montoUYU)} UYU · ${categoria}`;
    }

    db.prepare("INSERT INTO gastos (usuario, descripcion, monto, categoria, fecha, nota) VALUES (?, ?, ?, ?, ?, ?)").run(usuario, descripcion, monto, categoria, hoy, nota || "");
    return `✅ Gasto registrado!\n📝 ${descripcion}\n💰 $${fmt(monto)} UYU · ${categoria}`;
  }

  if (accion.accion === "registrar_ingreso") {
    const { descripcion, nota } = accion;
    let monto = parseFloat(accion.monto);
    const moneda = (accion.moneda || "UYU").toUpperCase();
    if (!descripcion || !monto) return "❌ Faltan datos para registrar el ingreso.";

    if (moneda === "USD") {
      const tc = await getTipoCambioBROU();
      if (!tc) return "⚠️ No pude obtener el TC del BROU. Intentá de nuevo o cargá el monto en pesos.";
      const montoUYU = Math.round(monto * tc);
      const notaFinal = `USD ${monto.toFixed(2)} × TC $${tc.toFixed(2)}${nota ? " | "+nota : ""}`;
      db.prepare("INSERT INTO ingresos (usuario, descripcion, monto, fecha, nota) VALUES (?, ?, ?, ?, ?)").run(usuario, descripcion, montoUYU, hoy, notaFinal);
      return `✅ Ingreso registrado!\n📝 ${descripcion}\n💵 U$S ${monto.toFixed(2)} × TC $${tc.toFixed(2)}\n💰 $${fmt(montoUYU)} UYU`;
    }

    db.prepare("INSERT INTO ingresos (usuario, descripcion, monto, fecha, nota) VALUES (?, ?, ?, ?, ?)").run(usuario, descripcion, monto, hoy, nota || "");
    return `✅ Ingreso registrado!\n📝 ${descripcion}\n💵 $${fmt(monto)} UYU`;
  }

  if (accion.accion === "ver_ingresos") {
    const ingresos = getIngresosMes(usuario);
    if (ingresos.length === 0) return "💵 No hay ingresos registrados este mes.";
    const total = ingresos.reduce((s,i)=>s+i.monto,0);
    const lineas = ingresos.map((i,n)=>`${n+1}. ${i.descripcion} · $${fmt(i.monto)} UYU (${i.fecha}) [#${i.id}]`).join("\n");
    const mes = ahora.toLocaleDateString("es-UY",{month:"long"});
    return `💵 *Ingresos de ${mes}*\n\n${lineas}\n\n*Total: $${fmt(total)} UYU*`;
  }

  if (accion.accion === "eliminar_ultimo_ingreso") {
    const u = db.prepare("SELECT * FROM ingresos WHERE usuario = ? ORDER BY created_at DESC LIMIT 1").get(usuario);
    if (!u) return "❌ No hay ingresos para eliminar.";
    db.prepare("DELETE FROM ingresos WHERE id = ?").run(u.id);
    return `🗑️ Último ingreso eliminado:\n📝 ${u.descripcion}\n💵 $${fmt(u.monto)} UYU`;
  }

  if (accion.accion === "saldo") {
    const gastos = getGastosMes(usuario);
    const ingresos = getIngresosMes(usuario);
    const totalGastos = gastos.reduce((s,g)=>s+g.monto,0);
    const totalIngresos = ingresos.reduce((s,i)=>s+i.monto,0);
    const saldo = totalIngresos - totalGastos;
    const mes = ahora.toLocaleDateString("es-UY",{month:"long"});
    const icono = saldo >= 0 ? "🟢" : "🔴";
    return `💰 *Saldo de ${mes}*\n\n💵 Ingresos: $${fmt(totalIngresos)} UYU\n💸 Gastos: $${fmt(totalGastos)} UYU\n${icono} *Saldo: $${fmt(saldo)} UYU*`;
  }

  if (accion.accion === "eliminar_ultimo") {
    const u = db.prepare("SELECT * FROM gastos WHERE usuario = ? ORDER BY created_at DESC LIMIT 1").get(usuario);
    if (!u) return "❌ No hay gastos para eliminar.";
    db.prepare("DELETE FROM gastos WHERE id = ?").run(u.id);
    return `🗑️ Último gasto eliminado:\n📝 ${u.descripcion}\n💰 $${fmt(u.monto)} UYU · ${u.categoria}`;
  }

  if (accion.accion === "ver_ultimos") {
    const ultimos = getUltimosGastos(usuario, 8);
    if (ultimos.length === 0) return "📋 No hay gastos registrados.";
    const lineas = ultimos.map((g,i)=>`${i+1}. ${g.descripcion} · $${fmt(g.monto)} UYU · ${g.categoria} (${g.fecha}) [#${g.id}]`).join("\n");
    return `📋 *Últimos gastos:*\n\n${lineas}\n\n¿Cuál querés eliminar o modificar?`;
  }

  if (accion.accion === "eliminar_id") {
    const g = db.prepare("SELECT * FROM gastos WHERE id = ? AND usuario = ?").get(accion.id, usuario);
    if (!g) return "❌ No encontré ese gasto.";
    db.prepare("DELETE FROM gastos WHERE id = ?").run(accion.id);
    return `🗑️ Eliminado:\n📝 ${g.descripcion}\n💰 $${fmt(g.monto)} UYU · ${g.categoria}`;
  }

  if (accion.accion === "cambiar_categoria") {
    const g = db.prepare("SELECT * FROM gastos WHERE id = ? AND usuario = ?").get(accion.id, usuario);
    if (!g) return "❌ No encontré ese gasto.";
    db.prepare("UPDATE gastos SET categoria = ? WHERE id = ?").run(accion.categoria, accion.id);
    return `✅ Categoría actualizada:\n📝 ${g.descripcion}\n📁 ${g.categoria} → ${accion.categoria}`;
  }

  if (accion.accion === "resumen") {
    const gastos = getGastosMes(usuario);
    const ingresos = getIngresosMes(usuario);
    if (gastos.length === 0) return "📊 No hay gastos registrados este mes.";
    const totalGastos = gastos.reduce((s,g)=>s+g.monto,0);
    const totalIngresos = ingresos.reduce((s,i)=>s+i.monto,0);
    const saldo = totalIngresos - totalGastos;
    const catTotals = {};
    gastos.forEach(g=>{catTotals[g.categoria]=(catTotals[g.categoria]||0)+g.monto;});
    const lineas = Object.entries(catTotals).sort((a,b)=>b[1]-a[1]).map(([c,v])=>`  • ${c}: $${fmt(v)}`).join("\n");
    const mes = ahora.toLocaleDateString("es-UY",{month:"long"});
    const saldoLinea = totalIngresos > 0 ? `\n💵 Ingresos: $${fmt(totalIngresos)} UYU\n${saldo>=0?"🟢":"🔴"} Saldo: $${fmt(saldo)} UYU` : "";
    return `📊 *Resumen de ${mes}*\n\n${lineas}\n\n💳 *Gastos: $${fmt(totalGastos)} UYU*${saldoLinea}\n(${gastos.length} transacciones)`;
  }

  if (accion.accion === "presupuestos") {
    const presupuestos = getPresupuestos(usuario);
    if (presupuestos.length === 0) return "📋 No hay presupuestos. Decime categoría y límite para crear uno.";
    const gastosMes = getGastosMes(usuario);
    const catTotals = {};
    gastosMes.forEach(g=>{catTotals[g.categoria]=(catTotals[g.categoria]||0)+g.monto;});
    const lineas = presupuestos.map(p=>{
      const gastado = catTotals[p.categoria]||0;
      const pct = Math.round(gastado/p.limite*100);
      return `${pct>=100?"🔴":pct>=80?"🟡":"🟢"} ${p.categoria}: $${fmt(gastado)}/$${fmt(p.limite)} (${pct}%)`;
    }).join("\n");
    return `📋 *Estado de presupuestos*\n\n${lineas}`;
  }

  if (accion.accion === "guardar_presupuesto") {
    const { categoria, limite } = accion;
    if (!categoria || !limite) return "❌ Necesito categoría y límite.";
    db.prepare(`INSERT INTO presupuestos (usuario, categoria, limite) VALUES (?, ?, ?)
      ON CONFLICT(usuario, categoria) DO UPDATE SET limite = excluded.limite`).run(usuario, categoria, parseFloat(limite));
    return `✅ Presupuesto guardado!\n📁 ${categoria}: $${fmt(parseFloat(limite))} UYU/mes`;
  }

  if (accion.accion === "texto") return accion.mensaje;
  return accion.mensaje || "No entendí eso. Intentá de nuevo.";
}

// ── PROCESAR FACTURA ──────────────────────────────────────────────────────────
async function procesarFactura(usuario, mediaUrl) {
  try {
    const response = await fetch(mediaUrl, {
      headers: { Authorization: "Basic " + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64") }
    });
    const base64 = Buffer.from(await response.arrayBuffer()).toString("base64");
    const contentType = response.headers.get("content-type") || "image/jpeg";

    const result = await llamarAnthropic({
      model: "claude-sonnet-4-20250514", max_tokens: 500,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: contentType, data: base64 } },
        { type: "text", text: `Analizá esta factura. Extraé: descripción del comercio, monto total, moneda (UYU o USD), y categoría de: ${CATEGORIAS.join(", ")}.\nRespondé SOLO con JSON:\n{"descripcion":"...","monto":0.00,"moneda":"UYU","categoria":"...","nota":"..."}` }
      ]}]
    });

    const datos = JSON.parse(result.content[0].text.trim().replace(/```json|```/g,"").trim());
    const resp = await ejecutarAccion(usuario, { accion:"registrar", ...datos });
    return `📸 *Factura procesada!*\n\n${resp}`;
  } catch (e) {
    console.error("Error factura:", e);
    return "❌ No pude leer la factura. Registrá el gasto manualmente.";
  }
}

// ── ENVIAR A MAMÁ ─────────────────────────────────────────────────────────────
async function enviarAMama(mensaje) {
  if (!NUMERO_MAMA) { console.log("⚠️ NUMERO_MAMA no configurado"); return; }
  try {
    await twilioClient.messages.create({ from: `whatsapp:${TWILIO_NUMBER}`, to: NUMERO_MAMA, body: mensaje });
    console.log(`✅ Enviado a ${NUMERO_MAMA}`);
  } catch (e) { console.error(`❌ Error enviando a ${NUMERO_MAMA}:`, e.message); }
}

// ── SCHEDULER ────────────────────────────────────────────────────────────────
function iniciarScheduler() {
  setInterval(async () => {
    const horaUY = new Date(Date.now() - 3*60*60*1000);
    const hora = horaUY.getUTCHours(), minuto = horaUY.getUTCMinutes();
    const diaSemana = horaUY.getUTCDay(), diaDelMes = horaUY.getUTCDate();
    const ultimoDiaMes = new Date(horaUY.getUTCFullYear(), horaUY.getUTCMonth()+1, 0).getUTCDate();
    if (minuto !== 0) return;

    if (hora === 21) {
      const hoy = horaUY.toISOString().split("T")[0];
      const { total } = db.prepare("SELECT COUNT(*) as total FROM gastos WHERE usuario = ? AND fecha = ?").get(USUARIO_MAMA, hoy);
      if (total === 0) await enviarAMama("📌 *MamiFin:* ¿Cómo anduvo el día? Si hiciste algún gasto, contame para cargarlo 😊");
    }
    if (diaSemana === 1 && hora === 9) {
      const gastos = getGastosMes(USUARIO_MAMA);
      const ingresos = getIngresosMes(USUARIO_MAMA);
      const totalGastos = gastos.reduce((s,g)=>s+g.monto,0);
      const totalIngresos = ingresos.reduce((s,i)=>s+i.monto,0);
      const saldo = totalIngresos - totalGastos;
      const catTotals = {};
      gastos.forEach(g=>{catTotals[g.categoria]=(catTotals[g.categoria]||0)+g.monto;});
      const top3 = Object.entries(catTotals).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([c,v])=>`  • ${c}: $${fmt(v)}`).join("\n");
      const mes = horaUY.toLocaleDateString("es-UY",{month:"long"});
      const saldoLinea = totalIngresos > 0 ? `\n💵 Ingresos: $${fmt(totalIngresos)} UYU\n${saldo>=0?"🟢":"🔴"} Saldo: $${fmt(saldo)} UYU` : "";
      await enviarAMama(`📊 *Resumen semanal MamiFin*\n\nTop gastos de ${mes}:\n${top3}\n\n💳 Gastos: $${fmt(totalGastos)} UYU${saldoLinea}`);
    }
    if (diaDelMes === ultimoDiaMes && hora === 20) {
      const gastos = getGastosMes(USUARIO_MAMA);
      const ingresos = getIngresosMes(USUARIO_MAMA);
      const totalGastos = gastos.reduce((s,g)=>s+g.monto,0);
      const totalIngresos = ingresos.reduce((s,i)=>s+i.monto,0);
      const saldo = totalIngresos - totalGastos;
      const catTotals = {};
      gastos.forEach(g=>{catTotals[g.categoria]=(catTotals[g.categoria]||0)+g.monto;});
      const lineas = Object.entries(catTotals).sort((a,b)=>b[1]-a[1]).map(([c,v])=>`  • ${c}: $${fmt(v)}`).join("\n");
      const mes = horaUY.toLocaleDateString("es-UY",{month:"long"});
      const saldoLinea = totalIngresos > 0 ? `\n💵 Ingresos: $${fmt(totalIngresos)} UYU\n${saldo>=0?"🟢":"🔴"} Saldo: $${fmt(saldo)} UYU` : "";
      await enviarAMama(`🗓️ *Cierre de ${mes}*\n\n${lineas}\n\n💳 Gastos: $${fmt(totalGastos)} UYU${saldoLinea}\n(${gastos.length} transacciones)\n\n¡Buen mes! 🏠`);
    }
    if (hora === 12) {
      const gastos = getGastosMes(USUARIO_MAMA);
      const presupuestos = getPresupuestos(USUARIO_MAMA);
      const catTotals = {};
      gastos.forEach(g=>{catTotals[g.categoria]=(catTotals[g.categoria]||0)+g.monto;});
      const excedidos = presupuestos.filter(p=>(catTotals[p.categoria]||0)>p.limite);
      if (excedidos.length > 0) {
        const lineas = excedidos.map(p=>`  🔴 ${p.categoria}: $${fmt(catTotals[p.categoria]||0)}/$${fmt(p.limite)}`).join("\n");
        await enviarAMama(`⚠️ *MamiFin — Presupuesto excedido*\n\n${lineas}\n\n¡Ojo con los gastos!`);
      }
    }
  }, 60*1000);
  console.log("⏰ Scheduler iniciado (hora Uruguay UTC-3)");
}

// ── WEBHOOK ───────────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  try {
    const body = (req.body.Body || "").trim();
    const numMedia = parseInt(req.body.NumMedia || "0");
    const mediaUrl = req.body.MediaUrl0;
    const mediaType = req.body.MediaContentType0 || "";
    const usuario = USUARIO_MAMA;
    let respuesta = "";

    if (numMedia > 0 && mediaType.startsWith("image/")) {
      respuesta = await procesarFactura(usuario, mediaUrl);
    } else if (esReporte(body)) {
      const ahora = new Date();
      if (esHistoricoTexto(body)) {
        respuesta = respuestaReporte(usuario, null, null, "histórico completo");
      } else {
        const mesEsp = esMesEspecifico(body);
        if (mesEsp) {
          const labelMes = new Date(mesEsp.anio, mesEsp.mes-1, 1).toLocaleDateString("es-UY",{month:"long",year:"numeric"});
          respuesta = respuestaReporte(usuario, mesEsp.mes, mesEsp.anio, labelMes);
        } else {
          const mes = ahora.getMonth()+1, anio = ahora.getFullYear();
          const labelMes = ahora.toLocaleDateString("es-UY",{month:"long",year:"numeric"});
          respuesta = respuestaReporte(usuario, mes, anio, labelMes);
        }
      }
    } else {
      const historial = getHistorial(usuario);
      historial.push({ role: "user", content: body });
      const result = await llamarAnthropic({
        model: "claude-sonnet-4-20250514", max_tokens: 1000,
        system: buildContexto(usuario), messages: historial,
      });
      const rawRespuesta = result.content[0].text.trim();
      historial.push({ role: "assistant", content: rawRespuesta });
      saveHistorial(usuario, historial);
      const limpio = rawRespuesta.replace(/```json|```/g,"").trim();
      try {
        const accion = JSON.parse(limpio);
        if (accion && accion.accion) {
          respuesta = await ejecutarAccion(usuario, accion);
        } else {
          respuesta = rawRespuesta;
        }
      } catch {
        respuesta = rawRespuesta;
      }
    }

    twiml.message(respuesta);
  } catch (err) {
    console.error("Error en webhook:", err);
    twiml.message("❌ Ocurrió un error. Intentá de nuevo.");
  }
  res.type("text/xml").send(twiml.toString());
});

app.get("/", (req, res) => res.json({ status: "MamiFin Bot activo 🟢" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MamiFin Bot corriendo en puerto ${PORT}`);
  iniciarScheduler();
});
