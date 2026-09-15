import cron from "node-cron";
import { reconciliarComprasPendientes } from "../services/pagoService.js";

// Mismo intervalo que @Scheduled(fixedRate = 5, TimeUnit.MINUTES) en
// PagoService.java.
export function iniciarJobReconciliacion(): void {
  cron.schedule("*/5 * * * *", () => {
    reconciliarComprasPendientes().catch((e) => {
      console.error("[reconciliacion] fallo el ciclo:", e);
    });
  });
}
