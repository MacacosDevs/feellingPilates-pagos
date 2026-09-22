import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/stripe.js", async () => {
  const { stripeStub } = await import("../mocks/stripeStub.js");
  return { stripe: stripeStub };
});

const { stripeStub, resetStripeStub } = await import("../mocks/stripeStub.js");
const { app } = await import("../../src/app.js");
const { limpiarBD, crearUsuario, crearPaquete, crearCompra } = await import("../helpers/db.js");
const { prisma } = await import("../../src/lib/prisma.js");

function evento(type: string, object: unknown) {
  return { id: "evt_test", type, data: { object } };
}

function enviarWebhook(evt: unknown, { conFirma = true }: { conFirma?: boolean } = {}) {
  const req = request(app).post("/api/pagos/webhook").set("Content-Type", "application/json");
  if (conFirma) {
    req.set("Stripe-Signature", "t=1,v1=firma-de-prueba");
  }
  return req.send(JSON.stringify(evt ?? {}));
}

describe("POST /api/pagos/webhook", () => {
  beforeEach(async () => {
    await limpiarBD();
    resetStripeStub();
  });

  it("sin header Stripe-Signature responde 400 sin tocar pagoService", async () => {
    const res = await enviarWebhook(evento("payment_intent.succeeded", {}), { conFirma: false });
    expect(res.status).toBe(400);
    expect(stripeStub.webhooks.constructEvent).not.toHaveBeenCalled();
  });

  it("firma invalida o payload alterado responde 400 ValidacionError", async () => {
    stripeStub.webhooks.constructEvent.mockImplementationOnce(() => {
      throw new Error("invalid signature");
    });
    const res = await enviarWebhook(evento("payment_intent.succeeded", {}));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/firma/i);
  });

  it("tipo de evento no manejado responde 200 sin error", async () => {
    const evt = evento("customer.created", {});
    stripeStub.webhooks.constructEvent.mockReturnValueOnce(evt);
    const res = await enviarWebhook(evt);
    expect(res.status).toBe(200);
  });

  describe("payment_intent.succeeded", () => {
    it("para un intent.id que no corresponde a ninguna Compra no lanza (200)", async () => {
      const evt = evento("payment_intent.succeeded", { id: "pi_sin_compra", latest_charge: null });
      stripeStub.webhooks.constructEvent.mockReturnValueOnce(evt);
      const res = await enviarWebhook(evt);
      expect(res.status).toBe(200);
    });

    it("marca la compra como pagada y guarda datos del charge (comision, monto neto, tarjeta)", async () => {
      const usuarioId = await crearUsuario();
      const paquete = await crearPaquete({ vigenciaDias: 30 });
      const compra = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pendiente", stripePaymentIntentId: "pi_1" });

      stripeStub.charges.retrieve.mockResolvedValueOnce({
        payment_method_details: { card: { brand: "visa", last4: "4242" } },
        receipt_url: "https://stripe.test/recibo",
        balance_transaction: { fee: 300, net: 9700 },
        outcome: { risk_level: "normal" },
      });

      const evt = evento("payment_intent.succeeded", { id: "pi_1", latest_charge: "ch_1" });
      stripeStub.webhooks.constructEvent.mockReturnValueOnce(evt);
      const res = await enviarWebhook(evt);

      expect(res.status).toBe(200);
      const actual = await prisma.compra.findUniqueOrThrow({ where: { id: compra.id } });
      expect(actual.estado).toBe("pagada");
      expect(actual.montoComisionCentavos).toBe(300);
      expect(actual.montoNetoCentavos).toBe(9700);
      expect(actual.tarjetaMarca).toBe("visa");
      expect(actual.fechaExpiracion).not.toBeNull();
    });

    it("recibido dos veces (reentrega de Stripe) es idempotente: no reaplica ni duplica campos", async () => {
      const usuarioId = await crearUsuario();
      const paquete = await crearPaquete({ vigenciaDias: 30 });
      const compra = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pendiente", stripePaymentIntentId: "pi_1" });

      stripeStub.charges.retrieve.mockResolvedValue({
        payment_method_details: { card: { brand: "visa", last4: "4242" } },
        receipt_url: "https://stripe.test/recibo",
        balance_transaction: { fee: 300, net: 9700 },
        outcome: { risk_level: "normal" },
      });

      const evt = evento("payment_intent.succeeded", { id: "pi_1", latest_charge: "ch_1" });
      stripeStub.webhooks.constructEvent.mockReturnValue(evt);

      await enviarWebhook(evt);
      const primeraFechaExpiracion = (await prisma.compra.findUniqueOrThrow({ where: { id: compra.id } })).fechaExpiracion;

      await enviarWebhook(evt);
      const actual = await prisma.compra.findUniqueOrThrow({ where: { id: compra.id } });

      expect(actual.estado).toBe("pagada");
      expect(actual.fechaExpiracion?.getTime()).toBe(primeraFechaExpiracion?.getTime());
      // aplicarPagada hace early-return si estadoActual === "pagada": el
      // segundo evento no debe volver a pedir el charge por segunda vez para
      // esta compra especifica dentro de marcarComoPagada -- si se llamo, es
      // porque el guard de idempotencia no esta funcionando.
    });

    it("si charge.retrieve (balance_transaction expandido) falla, continua marcando pagada sin comision/monto neto", async () => {
      const usuarioId = await crearUsuario();
      const paquete = await crearPaquete({ vigenciaDias: 30 });
      const compra = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pendiente", stripePaymentIntentId: "pi_1" });

      stripeStub.charges.retrieve.mockRejectedValueOnce(new Error("network error al pedir el charge"));

      const evt = evento("payment_intent.succeeded", { id: "pi_1", latest_charge: "ch_1" });
      stripeStub.webhooks.constructEvent.mockReturnValueOnce(evt);
      const res = await enviarWebhook(evt);

      expect(res.status).toBe(200);
      const actual = await prisma.compra.findUniqueOrThrow({ where: { id: compra.id } });
      expect(actual.estado).toBe("pagada");
      expect(actual.montoComisionCentavos).toBeNull();
      expect(actual.montoNetoCentavos).toBeNull();
    });
  });

  describe("payment_intent.payment_failed", () => {
    it("guarda ultimoErrorCodigo/ultimoErrorMensaje", async () => {
      const usuarioId = await crearUsuario();
      const paquete = await crearPaquete();
      const compra = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pendiente", stripePaymentIntentId: "pi_1" });

      const evt = evento("payment_intent.payment_failed", {
        id: "pi_1",
        last_payment_error: { code: "insufficient_funds", message: "Fondos insuficientes" },
      });
      stripeStub.webhooks.constructEvent.mockReturnValueOnce(evt);
      const res = await enviarWebhook(evt);

      expect(res.status).toBe(200);
      const actual = await prisma.compra.findUniqueOrThrow({ where: { id: compra.id } });
      expect(actual.estado).toBe("fallida");
      expect(actual.ultimoErrorCodigo).toBe("insufficient_funds");
      expect(actual.ultimoErrorMensaje).toBe("Fondos insuficientes");
    });

    it("no lanza si no habia compra previa con ese intent", async () => {
      const evt = evento("payment_intent.payment_failed", { id: "pi_inexistente", last_payment_error: null });
      stripeStub.webhooks.constructEvent.mockReturnValueOnce(evt);
      const res = await enviarWebhook(evt);
      expect(res.status).toBe(200);
    });
  });

  describe("charge.refunded", () => {
    it("sin compras asociadas al payment_intent no falla ni reescribe", async () => {
      const evt = evento("charge.refunded", { payment_intent: "pi_sin_compras" });
      stripeStub.webhooks.constructEvent.mockReturnValueOnce(evt);
      const res = await enviarWebhook(evt);
      expect(res.status).toBe(200);
    });

    it("para una compra ya reembolsada no falla ni la reescribe", async () => {
      const usuarioId = await crearUsuario();
      const paquete = await crearPaquete();
      const compra = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "reembolsada", stripePaymentIntentId: "pi_1" });

      const evt = evento("charge.refunded", { payment_intent: "pi_1" });
      stripeStub.webhooks.constructEvent.mockReturnValueOnce(evt);
      const res = await enviarWebhook(evt);

      expect(res.status).toBe(200);
      const actual = await prisma.compra.findUniqueOrThrow({ where: { id: compra.id } });
      expect(actual.estado).toBe("reembolsada");
      expect(actual.actualizadoEn.getTime()).toBe(compra.actualizadoEn.getTime());
    });

    it("marca reembolsada una compra pagada cuando el reembolso se hizo fuera del endpoint propio (ej. Dashboard de Stripe)", async () => {
      const usuarioId = await crearUsuario();
      const paquete = await crearPaquete();
      const compra = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pagada", stripePaymentIntentId: "pi_1" });

      const evt = evento("charge.refunded", { payment_intent: "pi_1" });
      stripeStub.webhooks.constructEvent.mockReturnValueOnce(evt);
      const res = await enviarWebhook(evt);

      expect(res.status).toBe(200);
      const actual = await prisma.compra.findUniqueOrThrow({ where: { id: compra.id } });
      expect(actual.estado).toBe("reembolsada");
    });
  });

  describe("charge.dispute.created", () => {
    it("sin payment_intent asociado retorna sin error", async () => {
      const evt = evento("charge.dispute.created", { payment_intent: null });
      stripeStub.webhooks.constructEvent.mockReturnValueOnce(evt);
      const res = await enviarWebhook(evt);
      expect(res.status).toBe(200);
    });

    it("marca la compra como en_disputa", async () => {
      const usuarioId = await crearUsuario();
      const paquete = await crearPaquete();
      const compra = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pagada", stripePaymentIntentId: "pi_1" });

      const evt = evento("charge.dispute.created", { payment_intent: "pi_1" });
      stripeStub.webhooks.constructEvent.mockReturnValueOnce(evt);
      const res = await enviarWebhook(evt);

      expect(res.status).toBe(200);
      const actual = await prisma.compra.findUniqueOrThrow({ where: { id: compra.id } });
      expect(actual.estado).toBe("en_disputa");
    });
  });

  describe("charge.dispute.closed", () => {
    it("status 'won' vuelve la compra a pagada, y solo afecta compras en_disputa", async () => {
      const usuarioId = await crearUsuario();
      const paquete = await crearPaquete();
      const enDisputa = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "en_disputa", stripePaymentIntentId: "pi_1" });
      const otraNoAfectada = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "cancelada", stripePaymentIntentId: "pi_2" });

      const evt = evento("charge.dispute.closed", { payment_intent: "pi_1", status: "won" });
      stripeStub.webhooks.constructEvent.mockReturnValueOnce(evt);
      const res = await enviarWebhook(evt);

      expect(res.status).toBe(200);
      expect((await prisma.compra.findUniqueOrThrow({ where: { id: enDisputa.id } })).estado).toBe("pagada");
      expect((await prisma.compra.findUniqueOrThrow({ where: { id: otraNoAfectada.id } })).estado).toBe("cancelada");
    });

    it("cualquier otro status distinto de 'won' marca la compra como reembolsada", async () => {
      const usuarioId = await crearUsuario();
      const paquete = await crearPaquete();
      const enDisputa = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "en_disputa", stripePaymentIntentId: "pi_1" });

      const evt = evento("charge.dispute.closed", { payment_intent: "pi_1", status: "lost" });
      stripeStub.webhooks.constructEvent.mockReturnValueOnce(evt);
      const res = await enviarWebhook(evt);

      expect(res.status).toBe(200);
      expect((await prisma.compra.findUniqueOrThrow({ where: { id: enDisputa.id } })).estado).toBe("reembolsada");
    });

    it("no afecta una compra con el mismo payment_intent que no este en_disputa", async () => {
      const usuarioId = await crearUsuario();
      const paquete = await crearPaquete();
      const yaPagada = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pagada", stripePaymentIntentId: "pi_1" });

      const evt = evento("charge.dispute.closed", { payment_intent: "pi_1", status: "won" });
      stripeStub.webhooks.constructEvent.mockReturnValueOnce(evt);
      await enviarWebhook(evt);

      expect((await prisma.compra.findUniqueOrThrow({ where: { id: yaPagada.id } })).estado).toBe("pagada");
    });
  });
});
