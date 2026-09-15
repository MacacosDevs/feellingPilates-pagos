import { Router } from "express";
import { requireAuth, requierePermiso } from "../middleware/auth.js";
import * as pagoService from "../services/pagoService.js";

export const pagosRouter = Router();

pagosRouter.post("/paquetes/intento", requireAuth, async (req, res, next) => {
  try {
    const { paqueteIds, idempotencyKey } = req.body as { paqueteIds: string[]; idempotencyKey?: string };
    const resultado = await pagoService.crearIntentoPago(req.usuario!.id, paqueteIds, idempotencyKey ?? null);
    res.json(resultado);
  } catch (e) {
    next(e);
  }
});

pagosRouter.get("/mis-paquetes", requireAuth, async (req, res, next) => {
  try {
    res.json(await pagoService.obtenerPaquetesActivos(req.usuario!.id));
  } catch (e) {
    next(e);
  }
});

pagosRouter.get("/mis-compras", requireAuth, async (req, res, next) => {
  try {
    res.json(await pagoService.obtenerHistorialCompras(req.usuario!.id));
  } catch (e) {
    next(e);
  }
});

// Estado en vivo contra Stripe (no el guardado en la base), util justo
// despues de confirmar el pago en el cliente, antes de que llegue el webhook.
pagosRouter.get("/compras/:compraId/estado-en-vivo", requireAuth, async (req, res, next) => {
  try {
    res.json(await pagoService.obtenerEstadoEnVivo(req.params.compraId, req.usuario!.id));
  } catch (e) {
    next(e);
  }
});

pagosRouter.post("/compras/:compraId/reembolso", requireAuth, requierePermiso("pagos.reembolsar"), async (req, res, next) => {
  try {
    res.json(await pagoService.reembolsarCompra(req.params.compraId));
  } catch (e) {
    next(e);
  }
});

// Payouts a la cuenta bancaria del negocio -- informacion de la cuenta
// completa, no de un usuario ni de una compra puntual, por eso requiere un
// permiso propio en vez del de dueno de compra que usan las rutas de arriba.
pagosRouter.get("/admin/payouts", requireAuth, requierePermiso("pagos.ver_finanzas"), async (req, res, next) => {
  try {
    res.json(await pagoService.obtenerPayouts());
  } catch (e) {
    next(e);
  }
});

// Stripe llama este endpoint directo (sin JWT); la autenticidad se verifica
// con la firma Stripe-Signature contra STRIPE_WEBHOOK_SECRET, no con requireAuth.
// El body llega aqui como Buffer crudo (no JSON parseado): app.ts monta
// express.raw() para esta ruta especifica ANTES del express.json() global,
// porque la verificacion de firma de Stripe necesita el payload sin tocar.
pagosRouter.post("/webhook", async (req, res, next) => {
  try {
    const firma = req.header("Stripe-Signature");
    if (!firma) {
      res.status(400).json({ error: "Falta el header Stripe-Signature" });
      return;
    }
    const evento = pagoService.construirEventoWebhook(req.body as Buffer, firma);
    await pagoService.procesarWebhook(evento);
    res.status(200).end();
  } catch (e) {
    next(e);
  }
});
