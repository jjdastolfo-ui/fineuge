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
    moneda TEXT NOT NULL DEFAULT 'ARS',
    fecha TEXT NOT NULL,
    nota TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS cambios_moneda (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario TEXT NOT NULL,
    moneda_origen TEXT NOT NULL,
    monto_origen REAL NOT NULL,
    moneda_destino TEXT NOT NULL,
    monto_destino REAL NOT NULL,
    tc REAL NOT NULL,
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

let tcCache = { blue: null, oficial: null, eurOficial: null, fecha: null };

async function getCotizaciones() {
  const ahora = new Date();
  if (tcCache.fecha && (ahora - tcCache.fecha) < 60*60*1000) return tcCache;
  try {
    const [blueResp, oficialResp, eurResp] = await Promise.all([
      fetch("https://dolarapi.com/v1/dolares/blue"),
      fetch("https://dolarapi.com/v1/dolares/oficial"),
      fetch("https://dolarapi.com/v1/cotizaciones/eur")
    ]);
    const blue = await blueResp.json();
    const oficial = await oficialResp.json();
    const eur = await eurResp.json();
    tcCache = {
      blue: { compra: parseFloat(blue.compra), venta: parseFloat(blue.venta) },
      oficial: { compra: parseFloat(oficial.compra), venta: parseFloat(oficial.venta) },
      eurOficial: { compra: parseFloat(eur.compra), venta: parseFloat(eur.venta) },
      fecha: ahora
    };
    console.log(`TC Blue: $${tcCache.blue.venta} venta | Oficial: $${tcCache.oficial.venta} | EUR: $${tcCache.eurOficial.venta}`);
    return tcCache;
  } catch (e) {
    console.error("Error API DolarApi:", e.message);
    return null;
  }
}

async function getDolarBlueVenta() {
  const c = await getCotizaciones();
  return c?.blue?.venta || null;
}

async function getEurBlueCalculado() {
  const c = await getCotizaciones();
  if (!c?.blue?.venta || !c?.oficial?.venta || !c?.eurOficial?.venta) return null;
  const ratio = c.eurOficial.venta / c.oficial.venta;
  return Math.round(ratio * c.blue.venta * 100) / 100;
}

async function convertirAARS(monto, moneda) {
  moneda = (moneda || "ARS").toUpperCase();
  if (moneda === "ARS") return { montoARS: monto, tc: 1 };
  if (moneda === "USD") {
    const tc = await getDolarBlueVenta();
    if (!tc) return null;
    return { montoARS: Math.round(monto * tc), tc };
  }
  if (moneda === "EUR") {
    const tc = await getEurBlueCalculado();
    if (!tc) return null;
    return { montoARS: Math.round(monto * tc), tc };
  }
  return null;
}

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

function limpiarHistorial(usuario) {
  db.prepare("DELETE FROM sesiones WHERE usuario = ?").run(usuario);
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

function getCambiosMoneda(usuario, mes, anio) {
  if (mes && anio) {
    const patron = `${anio}-${String(mes).padStart(2,"0")}-%`;
    return db.prepare("SELECT * FROM cambios_moneda WHERE usuario = ? AND fecha LIKE ? ORDER BY fecha ASC").all(usuario, patron);
  }
  return db.prepare("SELECT * FROM cambios_moneda WHERE usuario = ? ORDER BY fecha ASC").all(usuario);
}

function getPresupuestos(usuario) {
  return db.prepare("SELECT * FROM presupuestos WHERE usuario = ?").all(usuario);
}

function getUltimosGastos(usuario, limite = 8) {
  return db.prepare("SELECT * FROM gastos WHERE usuario = ? ORDER BY created_at DESC LIMIT ?").all(usuario, limite);
}

function getUltimosIngresos(usuario, limite = 5) {
  return db.prepare("SELECT * FROM ingresos WHERE usuario = ? ORDER BY created_at DESC LIMIT ?").all(usuario, limite);
}

function fmt(n) { return Math.round(n).toLocaleString("es-AR"); }
function fmtDec(n) { return (Math.round(n*100)/100).toLocaleString("es-AR", {minimumFractionDigits:2, maximumFractionDigits:2}); }

function calcularSaldosPorMoneda(usuario, mes, anio) {
  const ingresos = mes && anio
    ? db.prepare("SELECT * FROM ingresos WHERE usuario = ? AND fecha LIKE ? ORDER BY fecha ASC").all(usuario, `${anio}-${String(mes).padStart(2,"0")}-%`)
    : db.prepare("SELECT * FROM ingresos WHERE usuario = ? ORDER BY fecha ASC").all(usuario);
  const gastos = mes && anio
    ? db.prepare("SELECT * FROM gastos WHERE usuario = ? AND fecha LIKE ? ORDER BY fecha ASC").all(usuario, `${anio}-${String(mes).padStart(2,"0")}-%`)
    : db.prepare("SELECT * FROM gastos WHERE usuario = ? ORDER BY fecha ASC").all(usuario);
  const cambios = getCambiosMoneda(usuario, mes, anio);

  const saldos = { ARS: 0, USD: 0, EUR: 0 };
  ingresos.forEach(i => { saldos[i.moneda || "ARS"] = (saldos[i.moneda || "ARS"] || 0) + i.monto; });
  const totalGastosARS = gastos.reduce((s,g)=>s+g.monto,0);
  saldos.ARS -= totalGastosARS;
  cambios.forEach(c => {
    saldos[c.moneda_origen] = (saldos[c.moneda_origen] || 0) - c.monto_origen;
    saldos[c.moneda_destino] = (saldos[c.moneda_destino] || 0) + c.monto_destino;
  });
  return { saldos, totalGastosARS, ingresos, gastos, cambios };
}

function generarYGuardarCSV(usuario, mes, anio) {
  let gastos, ingresos, cambios;
  if (!mes && !anio) {
    gastos = db.prepare("SELECT * FROM gastos WHERE usuario = ? ORDER BY fecha ASC").all(usuario);
    ingresos = db.prepare("SELECT * FROM ingresos WHERE usuario = ? ORDER BY fecha ASC").all(usuario);
    cambios = db.prepare("SELECT * FROM cambios_moneda WHERE usuario = ? ORDER BY fecha ASC").all(usuario);
  } else {
    const patron = `${anio}-${String(mes).padStart(2,"0")}-%`;
    gastos = db.prepare("SELECT * FROM gastos WHERE usuario = ? AND fecha LIKE ? ORDER BY fecha ASC").all(usuario, patron);
    ingresos = db.prepare("SELECT * FROM ingresos WHERE usuario = ? AND fecha LIKE ? ORDER BY fecha ASC").all(usuario, patron);
    cambios = db.prepare("SELECT * FROM cambios_moneda WHERE usuario = ? AND fecha LIKE ? ORDER BY fecha ASC").all(usuario, patron);
  }
  if ((!gastos || gastos.length === 0) && (!ingresos || ingresos.length === 0) && (!cambios || cambios.length === 0)) return null;

  const catTotals = {};
  gastos.forEach(g => { catTotals[g.categoria] = (catTotals[g.categoria]||0) + g.monto; });
  const totalGastos = gastos.reduce((s,g) => s+g.monto, 0);
  const ingresosPorMoneda = { ARS: 0, USD: 0, EUR: 0 };
  ingresos.forEach(i => { const m = i.moneda || "ARS"; ingresosPorMoneda[m] = (ingresosPorMoneda[m]||0) + i.monto; });

  const bom = "\uFEFF";
  const csv = bom +
    "GASTOS (siempre en ARS)\nID,Fecha,Descripción,Monto (ARS),Categoría,Nota\n" +
    gastos.map(g => `${g.id},${g.fecha},"${(g.descripcion||"").replace(/"/g,'""')}",${g.monto.toFixed(2)},"${g.categoria}","${(g.nota||"").replace(/"/g,'""')}"`).join("\n") +
    "\n\nINGRESOS (moneda original)\nID,Fecha,Descripción,Monto,Moneda,Nota\n" +
    (ingresos.length > 0 ? ingresos.map(i => `${i.id},${i.fecha},"${(i.descripcion||"").replace(/"/g,'""')}",${i.monto.toFixed(2)},${i.moneda||"ARS"},"${(i.nota||"").replace(/"/g,'""')}"`).join("\n") : "(sin ingresos)") +
    "\n\nCAMBIOS DE MONEDA\nID,Fecha,Monto Origen,Moneda Origen,Monto Destino,Moneda Destino,TC,Nota\n" +
    (cambios.length > 0 ? cambios.map(c => `${c.id},${c.fecha},${c.monto_origen.toFixed(2)},${c.moneda_origen},${c.monto_destino.toFixed(2)},${c.moneda_destino},${c.tc.toFixed(2)},"${(c.nota||"").replace(/"/g,'""')}"`).join("\n") : "(sin cambios)") +
    "\n\nRESUMEN POR CATEGORÍA\nCategoría,Total (ARS)\n" +
    Object.entries(catTotals).sort((a,b)=>b[1]-a[1]).map(([c,v])=>`"${c}",${v.toFixed(2)}`).join("\n") +
    `\n\nTOTAL GASTOS ARS,${totalGastos.toFixed(2)}` +
    `\nTOTAL INGRESOS ARS,${ingresosPorMoneda.ARS.toFixed(2)}` +
    `\nTOTAL INGRESOS USD,${ingresosPorMoneda.USD.toFixed(2)}` +
    `\nTOTAL INGRESOS EUR,${ingresosPorMoneda.EUR.toFixed(2)}`;

  const hoy = new Date().toISOString().split("T")[0];
  const nombre = (!mes&&!anio) ? `mamifin_historico_${hoy}.csv` : `mamifin_${anio}_${String(mes).padStart(2,"0")}.csv`;
  const dir = path.join(DB_DIR, "reportes");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, nombre), csv, "utf8");

  return { nombreArchivo: nombre, totalGastos, ingresosPorMoneda, catTotals, cantidad: gastos.length, cantidadIngresos: ingresos.length, cantidadCambios: cambios.length };
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

// Endpoint temporal para limpiar historial contaminado
app.get("/reset-historial", (req, res) => {
  limpiarHistorial(USUARIO_MAMA);
  res.json({ ok: true, mensaje: "Historial limpiado. Próximo mensaje al bot es turno nuevo." });
});

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
  if (!r) return `📊 No hay movimientos para ${labelMes}.`;
  const top5 = Object.entries(r.catTotals).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const lineas = top5.map(([c,v])=>`  • ${c}: $${fmt(v)}`).join("\n");
  const mas = Object.keys(r.catTotals).length>5?"\n  ...":"";
  const ingLineas = [];
  if (r.ingresosPorMoneda.ARS > 0) ingLineas.push(`  • ARS: $${fmt(r.ingresosPorMoneda.ARS)}`);
  if (r.ingresosPorMoneda.USD > 0) ingLineas.push(`  • USD: U$S ${fmtDec(r.ingresosPorMoneda.USD)}`);
  if (r.ingresosPorMoneda.EUR > 0) ingLineas.push(`  • EUR: € ${fmtDec(r.ingresosPorMoneda.EUR)}`);
  const ingresoBloque = ingLineas.length > 0 ? `\n\n💵 *Ingresos:*\n${ingLineas.join("\n")}` : "";
  const link = PUBLIC_URL ? `\n\n📎 Descargá el CSV:\n${PUBLIC_URL}/reportes/${r.nombreArchivo}` : "";
  return `📊 *Reporte ${labelMes}*\n\n${lineas}${mas}\n\n💳 Gastos ARS: $${fmt(r.totalGastos)}${ingresoBloque}\n\n(${r.cantidad} gastos, ${r.cantidadIngresos} ingresos, ${r.cantidadCambios} cambios)${link}`;
}

function buildContexto(usuario) {
  const { saldos } = calcularSaldosPorMoneda(usuario);
  const gastosMes = getGastosMes(usuario);
  const ingresosMes = getIngresosMes(usuario);
  const presupuestos = getPresupuestos(usuario);
  const totalGastosARS = gastosMes.reduce((s,g)=>s+g.monto,0);
  const ingresosPorMonedaMes = { ARS: 0, USD: 0, EUR: 0 };
  ingresosMes.forEach(i => { const m = i.moneda || "ARS"; ingresosPorMonedaMes[m] = (ingresosPorMonedaMes[m]||0) + i.monto; });
  const ultimos = getUltimosGastos(usuario,8);
  const ultimosIng = getUltimosIngresos(usuario, 5);
  const catTotals = {};
  gastosMes.forEach(g=>{catTotals[g.categoria]=(catTotals[g.categoria]||0)+g.monto;});
  const presMap = {};
  presupuestos.forEach(p=>{presMap[p.categoria]=p.limite;});
  const excedidos = Object.keys(presMap).filter(c=>(catTotals[c]||0)>presMap[c]);
  const nombreMes = new Date().toLocaleDateString("es-AR",{month:"long",year:"numeric"});

  return `Eres MamiFin, asistente personal de finanzas de una señora argentina que vive sola. Respondés en español rioplatense (Argentina), con tono amable y cercano, conciso (máximo 4 líneas). Emojis con moderación.

MONEDAS: ARS (pesos argentinos), USD (dólares), EUR (euros).

REGLAS DE MONEDA:
- GASTOS: siempre se guardan en ARS. Si el usuario paga en USD o EUR, la conversión la hace el sistema automáticamente usando dólar blue (venta) o TC cruzado para euros. Por defecto moneda "ARS".
- INGRESOS: se guardan en la MONEDA ORIGINAL (ARS, USD o EUR). NO se convierten.
- CAMBIO DE MONEDA: cuando vende USD/EUR y recibe ARS, se registra como una sola operación que resta de la moneda origen y suma a la destino.

DETECCIÓN DE MONEDA EN MENSAJES:
- "500" o "500 pesos" o "500 ARS" → ARS
- "50 usd", "50 u$s", "50 dólares", "usd 50", "cobré 50 dólares" → USD
- "30 eur", "30 euros", "€30", "eur 30" → EUR

CATEGORÍAS GASTOS: ${CATEGORIAS.join(", ")}

REGLA CRÍTICA DE FORMATO DE RESPUESTA:
SIEMPRE que el usuario quiera registrar algo (gasto, ingreso, cambio de moneda) o pedir información de sus finanzas, respondés EXCLUSIVAMENTE con un objeto JSON puro, en una sola línea, SIN markdown, SIN backticks, SIN texto antes ni después. El sistema va a ejecutar la acción y generar la respuesta visible. NUNCA devuelvas el JSON envuelto en texto explicativo porque el usuario lo verá como texto crudo.

HERRAMIENTAS — respondé SOLO con JSON exacto sin texto extra:
{"accion":"registrar","descripcion":"...","monto":0.00,"moneda":"ARS","categoria":"...","nota":"..."}
{"accion":"registrar_ingreso","descripcion":"...","monto":0.00,"moneda":"ARS","nota":"..."}
{"accion":"cambio_moneda","monto_origen":0.00,"moneda_origen":"USD","moneda_destino":"ARS","monto_destino":0.00,"nota":"..."}
{"accion":"resumen"}
{"accion":"saldo"}
{"accion":"ver_ingresos"}
{"accion":"ver_cambios"}
{"accion":"eliminar_ultimo_ingreso"}
{"accion":"eliminar_ultimo_cambio"}
{"accion":"presupuestos"}
{"accion":"guardar_presupuesto","categoria":"...","limite":0.00}
{"accion":"eliminar_ultimo"}
{"accion":"ver_ultimos"}
{"accion":"eliminar_id","id":123}
{"accion":"cambiar_categoria","id":123,"categoria":"..."}
{"accion":"cotizacion"}
{"accion":"texto","mensaje":"..."}

EJEMPLOS:
Usuario: "cobré 50 dólares"
→ {"accion":"registrar_ingreso","descripcion":"Cobro","monto":50,"moneda":"USD","nota":""}

Usuario: "me depositaron 200 euros"
→ {"accion":"registrar_ingreso","descripcion":"Depósito","monto":200,"moneda":"EUR","nota":""}

Usuario: "vendí 100 dólares a 1400"
→ {"accion":"cambio_moneda","monto_origen":100,"moneda_origen":"USD","moneda_destino":"ARS","monto_destino":140000,"nota":""}

Usuario: "vendí 50 dólares"
→ {"accion":"cambio_moneda","monto_origen":50,"moneda_origen":"USD","moneda_destino":"ARS","monto_destino":0,"nota":""}

Usuario: "gasté 50 dólares en farmacia"
→ {"accion":"registrar","descripcion":"Farmacia","monto":50,"moneda":"USD","categoria":"Salud y Farmacia","nota":""}

Usuario: "hola cómo estás"
→ {"accion":"texto","mensaje":"¡Hola! Todo bien por acá 😊 ¿En qué te ayudo?"}

DATOS ACTUALES (${nombreMes}):
- Saldos acumulados: ARS $${fmt(saldos.ARS)}, USD $${fmtDec(saldos.USD)}, EUR €${fmtDec(saldos.EUR)}
- Gastos del mes (ARS): $${fmt(totalGastosARS)}
- Ingresos del mes: ARS $${fmt(ingresosPorMonedaMes.ARS)}, USD $${fmtDec(ingresosPorMonedaMes.USD)}, EUR €${fmtDec(ingresosPorMonedaMes.EUR)}
- Gastos por categoría: ${JSON.stringify(catTotals)}
- Presupuestos: ${JSON.stringify(presMap)}
- Excedidos: ${excedidos.join(", ")||"ninguno"}
- Últimos 8 gastos: ${JSON.stringify(ultimos.map(g=>({id:g.id,desc:g.descripcion,monto:g.monto,cat:g.categoria,fecha:g.fecha})))}
- Últimos 5 ingresos: ${JSON.stringify(ultimosIng.map(i=>({id:i.id,desc:i.descripcion,monto:i.monto,moneda:i.moneda,fecha:i.fecha})))}

NUNCA uses acción reporte_csv — los reportes se manejan automáticamente.`;
}

async function ejecutarAccion(usuario, accion) {
  const hoy = new Date().toISOString().split("T")[0];
  const ahora = new Date();

  if (accion.accion === "registrar") {
    const { descripcion, categoria, nota } = accion;
    let monto = parseFloat(accion.monto);
    const moneda = (accion.moneda || "ARS").toUpperCase();
    if (!descripcion || !monto || !categoria) return "❌ Faltan datos para registrar el gasto.";

    if (moneda !== "ARS") {
      const conv = await convertirAARS(monto, moneda);
      if (!conv) return "⚠️ No pude obtener el tipo de cambio. Intentá de nuevo o cargá el monto en pesos.";
      const simbolo = moneda === "USD" ? "U$S" : "€";
      const notaFinal = `${moneda} ${fmtDec(monto)} × TC $${fmtDec(conv.tc)}${nota ? " | "+nota : ""}`;
      db.prepare("INSERT INTO gastos (usuario, descripcion, monto, categoria, fecha, nota) VALUES (?, ?, ?, ?, ?, ?)").run(usuario, descripcion, conv.montoARS, categoria, hoy, notaFinal);
      return `✅ Gasto registrado!\n📝 ${descripcion}\n💵 ${simbolo} ${fmtDec(monto)} × TC $${fmtDec(conv.tc)}\n💰 $${fmt(conv.montoARS)} ARS · ${categoria}`;
    }

    db.prepare("INSERT INTO gastos (usuario, descripcion, monto, categoria, fecha, nota) VALUES (?, ?, ?, ?, ?, ?)").run(usuario, descripcion, monto, categoria, hoy, nota || "");
    return `✅ Gasto registrado!\n📝 ${descripcion}\n💰 $${fmt(monto)} ARS · ${categoria}`;
  }

  if (accion.accion === "registrar_ingreso") {
    const { descripcion, nota } = accion;
    let monto = parseFloat(accion.monto);
    const moneda = (accion.moneda || "ARS").toUpperCase();
    if (!descripcion || !monto) return "❌ Faltan datos para registrar el ingreso.";
    if (!["ARS","USD","EUR"].includes(moneda)) return "❌ Moneda no soportada. Usá ARS, USD o EUR.";

    db.prepare("INSERT INTO ingresos (usuario, descripcion, monto, moneda, fecha, nota) VALUES (?, ?, ?, ?, ?, ?)").run(usuario, descripcion, monto, moneda, hoy, nota || "");
    const simbolo = moneda === "ARS" ? "$" : moneda === "USD" ? "U$S" : "€";
    const montoFmt = moneda === "ARS" ? fmt(monto) : fmtDec(monto);
    return `✅ Ingreso registrado!\n📝 ${descripcion}\n💵 ${simbolo} ${montoFmt} ${moneda}`;
  }

  if (accion.accion === "cambio_moneda") {
    const monedaOrigen = (accion.moneda_origen || "USD").toUpperCase();
    const monedaDestino = (accion.moneda_destino || "ARS").toUpperCase();
    let montoOrigen = parseFloat(accion.monto_origen);
    let montoDestino = parseFloat(accion.monto_destino || 0);
    if (!montoOrigen) return "❌ Falta monto origen. Ej: \"vendí 100 dólares a 1400\".";
    if (!["ARS","USD","EUR"].includes(monedaOrigen) || !["ARS","USD","EUR"].includes(monedaDestino)) return "❌ Monedas soportadas: ARS, USD, EUR.";
    if (monedaOrigen === monedaDestino) return "❌ No tiene sentido cambiar de la misma moneda a sí misma.";

    let tc;
    if (!montoDestino) {
      if (monedaDestino === "ARS") {
        if (monedaOrigen === "USD") tc = await getDolarBlueVenta();
        else if (monedaOrigen === "EUR") tc = await getEurBlueCalculado();
        if (!tc) return "⚠️ No pude obtener TC. Decime el monto en pesos que recibió (ej. \"vendí 100 dólares a 1400\").";
        montoDestino = Math.round(montoOrigen * tc);
      } else if (monedaOrigen === "ARS") {
        if (monedaDestino === "USD") tc = await getDolarBlueVenta();
        else if (monedaDestino === "EUR") tc = await getEurBlueCalculado();
        if (!tc) return "⚠️ No pude obtener TC.";
        montoDestino = Math.round((montoOrigen / tc) * 100) / 100;
      } else {
        return "⚠️ Decime el monto destino directamente (ej. \"cambié 50 euros por 40 dólares\").";
      }
    } else {
      tc = Math.round((monedaDestino === "ARS" ? montoDestino/montoOrigen : montoOrigen/montoDestino) * 100) / 100;
    }

    db.prepare("INSERT INTO cambios_moneda (usuario, moneda_origen, monto_origen, moneda_destino, monto_destino, tc, fecha, nota) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(usuario, monedaOrigen, montoOrigen, monedaDestino, montoDestino, tc, hoy, accion.nota || "");

    const simO = monedaOrigen === "ARS" ? "$" : monedaOrigen === "USD" ? "U$S" : "€";
    const simD = monedaDestino === "ARS" ? "$" : monedaDestino === "USD" ? "U$S" : "€";
    const montoOFmt = monedaOrigen === "ARS" ? fmt(montoOrigen) : fmtDec(montoOrigen);
    const montoDFmt = monedaDestino === "ARS" ? fmt(montoDestino) : fmtDec(montoDestino);
    return `🔄 *Cambio de moneda registrado*\n\n➖ ${simO} ${montoOFmt} ${monedaOrigen}\n➕ ${simD} ${montoDFmt} ${monedaDestino}\n📊 TC: $${fmtDec(tc)}`;
  }

  if (accion.accion === "cotizacion") {
    const c = await getCotizaciones();
    if (!c) return "⚠️ No pude obtener las cotizaciones ahora.";
    const eurBlue = await getEurBlueCalculado();
    const fechaStr = c.fecha ? new Date(c.fecha).toLocaleString("es-AR", {timeZone:"America/Argentina/Buenos_Aires", day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit"}) : "";
    return `💱 *Cotizaciones*\n\n💵 USD Blue: $${fmtDec(c.blue.compra)} / $${fmtDec(c.blue.venta)}\n💵 USD Oficial: $${fmtDec(c.oficial.compra)} / $${fmtDec(c.oficial.venta)}\n💶 EUR (calc. blue): $${fmtDec(eurBlue)}\n\n⏰ ${fechaStr}`;
  }

  if (accion.accion === "ver_ingresos") {
    const ingresos = getIngresosMes(usuario);
    if (ingresos.length === 0) return "💵 No hay ingresos registrados este mes.";
    const totales = { ARS: 0, USD: 0, EUR: 0 };
    ingresos.forEach(i => { const m = i.moneda || "ARS"; totales[m] = (totales[m]||0) + i.monto; });
    const lineas = ingresos.map((i,n)=>{
      const m = i.moneda || "ARS";
      const sim = m === "ARS" ? "$" : m === "USD" ? "U$S" : "€";
      const montoFmt = m === "ARS" ? fmt(i.monto) : fmtDec(i.monto);
      return `${n+1}. ${i.descripcion} · ${sim} ${montoFmt} ${m} (${i.fecha}) [#${i.id}]`;
    }).join("\n");
    const mes = ahora.toLocaleDateString("es-AR",{month:"long"});
    const totalesLineas = [];
    if (totales.ARS > 0) totalesLineas.push(`  ARS: $${fmt(totales.ARS)}`);
    if (totales.USD > 0) totalesLineas.push(`  USD: U$S ${fmtDec(totales.USD)}`);
    if (totales.EUR > 0) totalesLineas.push(`  EUR: € ${fmtDec(totales.EUR)}`);
    return `💵 *Ingresos de ${mes}*\n\n${lineas}\n\n*Totales:*\n${totalesLineas.join("\n")}`;
  }

  if (accion.accion === "ver_cambios") {
    const cambios = getCambiosMoneda(usuario, ahora.getMonth()+1, ahora.getFullYear());
    if (cambios.length === 0) return "🔄 No hay cambios de moneda registrados este mes.";
    const lineas = cambios.map((c,n)=>{
      const simO = c.moneda_origen === "ARS" ? "$" : c.moneda_origen === "USD" ? "U$S" : "€";
      const simD = c.moneda_destino === "ARS" ? "$" : c.moneda_destino === "USD" ? "U$S" : "€";
      const mO = c.moneda_origen === "ARS" ? fmt(c.monto_origen) : fmtDec(c.monto_origen);
      const mD = c.moneda_destino === "ARS" ? fmt(c.monto_destino) : fmtDec(c.monto_destino);
      return `${n+1}. ${simO}${mO} ${c.moneda_origen} → ${simD}${mD} ${c.moneda_destino} @ $${fmtDec(c.tc)} (${c.fecha}) [#${c.id}]`;
    }).join("\n");
    const mes = ahora.toLocaleDateString("es-AR",{month:"long"});
    return `🔄 *Cambios de moneda de ${mes}*\n\n${lineas}`;
  }

  if (accion.accion === "eliminar_ultimo_ingreso") {
    const u = db.prepare("SELECT * FROM ingresos WHERE usuario = ? ORDER BY created_at DESC LIMIT 1").get(usuario);
    if (!u) return "❌ No hay ingresos para eliminar.";
    db.prepare("DELETE FROM ingresos WHERE id = ?").run(u.id);
    const sim = u.moneda === "ARS" ? "$" : u.moneda === "USD" ? "U$S" : "€";
    const montoFmt = u.moneda === "ARS" ? fmt(u.monto) : fmtDec(u.monto);
    return `🗑️ Último ingreso eliminado:\n📝 ${u.descripcion}\n💵 ${sim} ${montoFmt} ${u.moneda}`;
  }

  if (accion.accion === "eliminar_ultimo_cambio") {
    const u = db.prepare("SELECT * FROM cambios_moneda WHERE usuario = ? ORDER BY created_at DESC LIMIT 1").get(usuario);
    if (!u) return "❌ No hay cambios de moneda para eliminar.";
    db.prepare("DELETE FROM cambios_moneda WHERE id = ?").run(u.id);
    return `🗑️ Cambio eliminado:\n${u.monto_origen} ${u.moneda_origen} → ${u.monto_destino} ${u.moneda_destino}`;
  }

  if (accion.accion === "saldo") {
    const { saldos, totalGastosARS } = calcularSaldosPorMoneda(usuario);
    const mes = ahora.toLocaleDateString("es-AR",{month:"long"});
    const lineas = [];
    lineas.push(`${saldos.ARS >= 0 ? "🟢" : "🔴"} ARS: $${fmt(saldos.ARS)}`);
    lineas.push(`${saldos.USD >= 0 ? "🟢" : "🔴"} USD: U$S ${fmtDec(saldos.USD)}`);
    lineas.push(`${saldos.EUR >= 0 ? "🟢" : "🔴"} EUR: € ${fmtDec(saldos.EUR)}`);
    return `💰 *Saldo acumulado por moneda*\n(ingresos − gastos ± cambios)\n\n${lineas.join("\n")}\n\n💸 Gastos de ${mes}: $${fmt(totalGastosARS)} ARS`;
  }

  if (accion.accion === "eliminar_ultimo") {
    const u = db.prepare("SELECT * FROM gastos WHERE usuario = ? ORDER BY created_at DESC LIMIT 1").get(usuario);
    if (!u) return "❌ No hay gastos para eliminar.";
    db.prepare("DELETE FROM gastos WHERE id = ?").run(u.id);
    return `🗑️ Último gasto eliminado:\n📝 ${u.descripcion}\n💰 $${fmt(u.monto)} ARS · ${u.categoria}`;
  }

  if (accion.accion === "ver_ultimos") {
    const ultimos = getUltimosGastos(usuario, 8);
    if (ultimos.length === 0) return "📋 No hay gastos registrados.";
    const lineas = ultimos.map((g,i)=>`${i+1}. ${g.descripcion} · $${fmt(g.monto)} ARS · ${g.categoria} (${g.fecha}) [#${g.id}]`).join("\n");
    return `📋 *Últimos gastos:*\n\n${lineas}\n\n¿Cuál querés eliminar o modificar?`;
  }

  if (accion.accion === "eliminar_id") {
    const g = db.prepare("SELECT * FROM gastos WHERE id = ? AND usuario = ?").get(accion.id, usuario);
    if (!g) return "❌ No encontré ese gasto.";
    db.prepare("DELETE FROM gastos WHERE id = ?").run(accion.id);
    return `🗑️ Eliminado:\n📝 ${g.descripcion}\n💰 $${fmt(g.monto)} ARS · ${g.categoria}`;
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
    if (gastos.length === 0 && ingresos.length === 0) return "📊 No hay movimientos registrados este mes.";
    const totalGastos = gastos.reduce((s,g)=>s+g.monto,0);
    const ingPorMon = { ARS: 0, USD: 0, EUR: 0 };
    ingresos.forEach(i => { const m = i.moneda || "ARS"; ingPorMon[m] = (ingPorMon[m]||0) + i.monto; });
    const catTotals = {};
    gastos.forEach(g=>{catTotals[g.categoria]=(catTotals[g.categoria]||0)+g.monto;});
    const lineas = Object.entries(catTotals).sort((a,b)=>b[1]-a[1]).map(([c,v])=>`  • ${c}: $${fmt(v)}`).join("\n");
    const mes = ahora.toLocaleDateString("es-AR",{month:"long"});
    const ingLineas = [];
    if (ingPorMon.ARS > 0) ingLineas.push(`  ARS: $${fmt(ingPorMon.ARS)}`);
    if (ingPorMon.USD > 0) ingLineas.push(`  USD: U$S ${fmtDec(ingPorMon.USD)}`);
    if (ingPorMon.EUR > 0) ingLineas.push(`  EUR: € ${fmtDec(ingPorMon.EUR)}`);
    const ingBloque = ingLineas.length > 0 ? `\n\n💵 *Ingresos del mes:*\n${ingLineas.join("\n")}` : "";
    return `📊 *Resumen de ${mes}*\n\n${lineas || "  (sin gastos)"}\n\n💳 *Gastos: $${fmt(totalGastos)} ARS*${ingBloque}\n\n(${gastos.length} gastos)`;
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
    return `✅ Presupuesto guardado!\n📁 ${categoria}: $${fmt(parseFloat(limite))} ARS/mes`;
  }

  if (accion.accion === "texto") return accion.mensaje;
  return accion.mensaje || "No entendí eso. Intentá de nuevo.";
}

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
        { type: "text", text: `Analizá esta factura argentina. Extraé: descripción del comercio, monto total, moneda (ARS, USD o EUR), y categoría de: ${CATEGORIAS.join(", ")}.\nRespondé SOLO con JSON:\n{"descripcion":"...","monto":0.00,"moneda":"ARS","categoria":"...","nota":"..."}` }
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

async function enviarAMama(mensaje) {
  if (!NUMERO_MAMA) { console.log("⚠️ NUMERO_MAMA no configurado"); return; }
  try {
    await twilioClient.messages.create({ from: `whatsapp:${TWILIO_NUMBER}`, to: NUMERO_MAMA, body: mensaje });
    console.log(`✅ Enviado a ${NUMERO_MAMA}`);
  } catch (e) { console.error(`❌ Error enviando a ${NUMERO_MAMA}:`, e.message); }
}

function iniciarScheduler() {
  setInterval(async () => {
    const horaAR = new Date(Date.now() - 3*60*60*1000);
    const hora = horaAR.getUTCHours(), minuto = horaAR.getUTCMinutes();
    const diaSemana = horaAR.getUTCDay(), diaDelMes = horaAR.getUTCDate();
    const ultimoDiaMes = new Date(horaAR.getUTCFullYear(), horaAR.getUTCMonth()+1, 0).getUTCDate();
    if (minuto !== 0) return;

    if (hora === 21) {
      const hoy = horaAR.toISOString().split("T")[0];
      const { total } = db.prepare("SELECT COUNT(*) as total FROM gastos WHERE usuario = ? AND fecha = ?").get(USUARIO_MAMA, hoy);
      if (total === 0) await enviarAMama("📌 *MamiFin:* ¿Cómo anduvo el día? Si hiciste algún gasto, contame para cargarlo 😊");
    }
    if (diaSemana === 1 && hora === 9) {
      const gastos = getGastosMes(USUARIO_MAMA);
      const ingresos = getIngresosMes(USUARIO_MAMA);
      const totalGastos = gastos.reduce((s,g)=>s+g.monto,0);
      const ingPorMon = { ARS: 0, USD: 0, EUR: 0 };
      ingresos.forEach(i => { const m = i.moneda || "ARS"; ingPorMon[m] = (ingPorMon[m]||0) + i.monto; });
      const catTotals = {};
      gastos.forEach(g=>{catTotals[g.categoria]=(catTotals[g.categoria]||0)+g.monto;});
      const top3 = Object.entries(catTotals).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([c,v])=>`  • ${c}: $${fmt(v)}`).join("\n");
      const mes = horaAR.toLocaleDateString("es-AR",{month:"long"});
      const ingLineas = [];
      if (ingPorMon.ARS > 0) ingLineas.push(`ARS $${fmt(ingPorMon.ARS)}`);
      if (ingPorMon.USD > 0) ingLineas.push(`USD $${fmtDec(ingPorMon.USD)}`);
      if (ingPorMon.EUR > 0) ingLineas.push(`EUR €${fmtDec(ingPorMon.EUR)}`);
      const ingLinea = ingLineas.length > 0 ? `\n💵 Ingresos: ${ingLineas.join(" · ")}` : "";
      await enviarAMama(`📊 *Resumen semanal MamiFin*\n\nTop gastos de ${mes}:\n${top3 || "  (sin gastos)"}\n\n💳 Gastos: $${fmt(totalGastos)} ARS${ingLinea}`);
    }
    if (diaDelMes === ultimoDiaMes && hora === 20) {
      const gastos = getGastosMes(USUARIO_MAMA);
      const ingresos = getIngresosMes(USUARIO_MAMA);
      const totalGastos = gastos.reduce((s,g)=>s+g.monto,0);
      const ingPorMon = { ARS: 0, USD: 0, EUR: 0 };
      ingresos.forEach(i => { const m = i.moneda || "ARS"; ingPorMon[m] = (ingPorMon[m]||0) + i.monto; });
      const catTotals = {};
      gastos.forEach(g=>{catTotals[g.categoria]=(catTotals[g.categoria]||0)+g.monto;});
      const lineas = Object.entries(catTotals).sort((a,b)=>b[1]-a[1]).map(([c,v])=>`  • ${c}: $${fmt(v)}`).join("\n");
      const mes = horaAR.toLocaleDateString("es-AR",{month:"long"});
      const ingLineas = [];
      if (ingPorMon.ARS > 0) ingLineas.push(`ARS $${fmt(ingPorMon.ARS)}`);
      if (ingPorMon.USD > 0) ingLineas.push(`USD $${fmtDec(ingPorMon.USD)}`);
      if (ingPorMon.EUR > 0) ingLineas.push(`EUR €${fmtDec(ingPorMon.EUR)}`);
      const ingLinea = ingLineas.length > 0 ? `\n💵 Ingresos: ${ingLineas.join(" · ")}` : "";
      await enviarAMama(`🗓️ *Cierre de ${mes}*\n\n${lineas}\n\n💳 Gastos: $${fmt(totalGastos)} ARS${ingLinea}\n(${gastos.length} gastos)\n\n¡Buen mes! 🏠`);
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
  console.log("⏰ Scheduler iniciado (hora Argentina UTC-3)");
}

// Extrae JSON robustamente aunque Claude ponga texto alrededor
function extraerJSON(texto) {
  const limpio = texto.replace(/```json|```/g, "").trim();
  try { return JSON.parse(limpio); } catch {}
  // Buscar primer { y último } y parsear lo del medio
  const inicio = limpio.indexOf("{");
  const fin = limpio.lastIndexOf("}");
  if (inicio >= 0 && fin > inicio) {
    try { return JSON.parse(limpio.substring(inicio, fin + 1)); } catch {}
  }
  return null;
}

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
          const labelMes = new Date(mesEsp.anio, mesEsp.mes-1, 1).toLocaleDateString("es-AR",{month:"long",year:"numeric"});
          respuesta = respuestaReporte(usuario, mesEsp.mes, mesEsp.anio, labelMes);
        } else {
          const mes = ahora.getMonth()+1, anio = ahora.getFullYear();
          const labelMes = ahora.toLocaleDateString("es-AR",{month:"long",year:"numeric"});
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
      console.log(`📩 Usuario: "${body}"`);
      console.log(`🤖 Claude raw: ${rawRespuesta}`);

      const accion = extraerJSON(rawRespuesta);
      if (accion && accion.accion) {
        respuesta = await ejecutarAccion(usuario, accion);
      } else {
        respuesta = rawRespuesta;
      }

      // FIX CRÍTICO: guardamos en historial la RESPUESTA REAL, no el JSON crudo.
      // Así Claude no se "autoconvence" de responder con JSON visible en turnos futuros.
      historial.push({ role: "assistant", content: respuesta });
      saveHistorial(usuario, historial);
    }

    twiml.message(respuesta);
  } catch (err) {
    console.error("Error en webhook:", err);
    twiml.message("❌ Ocurrió un error. Intentá de nuevo.");
  }
  res.type("text/xml").send(twiml.toString());
});
// ── ENDPOINT PARA LIMPIAR HISTORIAL (TEMPORAL) ────────────────────────────────
app.get("/reset-sesion", (req, res) => {
  db.prepare("DELETE FROM sesiones WHERE usuario = ?").run(USUARIO_MAMA);
  res.json({ status: "✅ Historial de conversación borrado" });
});
app.get("/", (req, res) => res.json({ status: "MamiFin Bot activo 🟢 — Argentina v2" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MamiFin Bot corriendo en puerto ${PORT}`);
  iniciarScheduler();
});
