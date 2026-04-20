# 🏠 MamiFin — Bot de WhatsApp para Gastos Personales

Versión individual de CasaFin, pensada para una sola persona.
Bot inteligente con IA para registrar gastos, ver resúmenes, controlar presupuestos y escanear facturas desde WhatsApp.

---

## 🚀 Despliegue paso a paso

### Paso 1 — Crear repo en GitHub

1. Crear repo nuevo vacío en GitHub: `mamifin-whatsapp` (privado)
2. Subir estos 3 archivos: `index.js`, `package.json`, `README.md`

```bash
git init
git add .
git commit -m "Initial commit MamiFin"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/mamifin-whatsapp.git
git push -u origin main
```

---

### Paso 2 — Reutilizar API Key de Anthropic

Podés usar la **misma** que ya tenés en CasaFin/IMPROLUX (empieza con `sk-ant-...`).
No hace falta crear una nueva.

---

### Paso 3 — Crear cuenta Twilio nueva para tu madre

1. Entrar a **https://www.twilio.com/** → crear cuenta nueva (con otro email)
2. Activar el sandbox de WhatsApp: **Messaging → Try it out → Send a WhatsApp message**
3. Desde el WhatsApp de tu madre, enviar el código `join <palabra-palabra>` al número sandbox
4. Anotar: **Account SID**, **Auth Token** y el número sandbox (ej. `+14155238886`)

---

### Paso 4 — Crear proyecto NUEVO en Railway

1. **https://railway.app** → New Project → Deploy from GitHub repo
2. Seleccionar `mamifin-whatsapp`
3. En **Settings → Volumes**: crear volumen montado en `/data`
4. En **Variables**, agregar:

```
ANTHROPIC_API_KEY = sk-ant-xxxxx
TWILIO_ACCOUNT_SID = ACxxxxx (el de la cuenta NUEVA de tu madre)
TWILIO_AUTH_TOKEN = xxxxx (el de la cuenta NUEVA)
TWILIO_NUMBER = +14155238886 (sandbox de la cuenta NUEVA)
NUMERO_MAMA = whatsapp:+598XXXXXXXX (con código país, formato whatsapp:)
DB_PATH = /data/mamifin.db
PUBLIC_URL = https://mamifin-production.up.railway.app (te lo da Railway después del primer deploy)
```

5. Después del primer deploy, Railway te da una URL pública → copiala y pegala en `PUBLIC_URL`, redesplegá.

---

### Paso 5 — Conectar Twilio con Railway

En Twilio (cuenta nueva de tu madre), ir a:
**Messaging → Try it out → Send a WhatsApp message → Sandbox settings**

En **"When a message comes in"** pegar:
```
https://mamifin-production.up.railway.app/webhook
```
Método: **HTTP POST** → Save.

---

### Paso 6 — Probar

Desde el WhatsApp de tu madre (con sandbox ya activado), mandar:
```
gasté 500 en la farmacia
```
Debería responder confirmando el registro.

---

## 💬 Ejemplos de uso para tu madre

| Qué escribe | Qué hace el bot |
|---|---|
| `gasté 800 en el super` | Registra el gasto |
| `gasté 50 usd en la farmacia` | Convierte a pesos con TC BROU |
| `cuánto gasté este mes` | Muestra resumen |
| `saldo` | Gastos vs ingresos del mes |
| `reporte` | Genera CSV descargable |
| `reporte histórico` | CSV con todo |
| `reporte agosto` | CSV de ese mes |
| `ver últimos gastos` | Lista los últimos 8 |
| `borrar el último` | Elimina último gasto |
| 📸 foto de ticket | Lee la factura y la registra |

---

## 📆 Avisos automáticos

- **21hs todos los días** → si no hubo gastos, pregunta cómo anduvo el día
- **Lunes 9hs** → resumen semanal con top 3 categorías
- **Último día del mes 20hs** → cierre mensual completo
- **12hs** → alerta si algún presupuesto se excedió

---

## 🆚 Diferencias con CasaFin

| | CasaFin | MamiFin |
|---|---|---|
| Usuarios | Familia compartida | Individual |
| Variable entorno | `NUMEROS_FAMILIA` (lista) | `NUMERO_MAMA` (uno) |
| Integración IMPROLUX | Sí (prefijo `IMP`) | No |
| DB por defecto | `casafin.db` | `mamifin.db` |
| Prefijo CSV | `casafin_*` | `mamifin_*` |

---

## 🔐 Variables de entorno — resumen

| Variable | Obligatoria | Descripción |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | Mismo que CasaFin |
| `TWILIO_ACCOUNT_SID` | ✅ | Cuenta NUEVA de tu madre |
| `TWILIO_AUTH_TOKEN` | ✅ | Cuenta NUEVA |
| `TWILIO_NUMBER` | ✅ | Sandbox nuevo |
| `NUMERO_MAMA` | ✅ | `whatsapp:+598XXXXXXXX` |
| `DB_PATH` | ✅ | `/data/mamifin.db` |
| `PUBLIC_URL` | ⚠️ | Para links de CSV descargables |

---

## ❓ Problemas frecuentes

**El bot no responde**
→ Verificar que el sandbox de Twilio esté activado desde el WhatsApp de tu madre (el `join <palabra>` hay que renovarlo cada 3 días en el sandbox gratis).

**Los datos se borran al redesplegar**
→ Volumen Railway montado en `/data` + `DB_PATH=/data/mamifin.db`.

**No llegan los avisos automáticos**
→ Chequear que `NUMERO_MAMA` esté con formato `whatsapp:+598XXXXXXXX` (con prefijo `whatsapp:` y código país).

**Sandbox se cae cada 3 días**
→ Limitación del sandbox gratis. Para producción definitiva, hay que registrar un número de WhatsApp Business dedicado (igual que estás haciendo con IMPROLUX).
