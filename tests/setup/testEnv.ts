import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const infoPath = path.resolve(__dirname, "../.tmp/test-env.json");
const info = JSON.parse(fs.readFileSync(infoPath, "utf-8")) as { databaseUrl: string };

// Debe ejecutarse (setupFiles) antes de que cualquier test importe src/app.ts
// o src/config/env.ts, porque env.ts lee estas variables al ser importado.
process.env.DATABASE_URL = info.databaseUrl;
process.env.JWT_SECRETO = "secreto-de-pruebas-nunca-usar-en-produccion-32b";
process.env.STRIPE_SECRET_KEY = "sk_test_dummy_no_se_llama_nunca";
process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_dummy";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_dummy";
process.env.COMPRA_PENDIENTE_EXPIRA_MINUTOS = "60";
process.env.CORS_ORIGENES_PERMITIDOS = "http://localhost:5173";
process.env.PORT = "0";
// Mismo mecanismo que en produccion (ver reusarSiExiste en pagoService.ts),
// pero con una ventana mucho mas corta para que los tests de la carrera de
// idempotencyKey no tarden segundos reales en correr.
process.env.IDEMPOTENCY_ESPERA_INTERVALO_MS = "20";
process.env.IDEMPOTENCY_ESPERA_MAX_INTENTOS = "10";
