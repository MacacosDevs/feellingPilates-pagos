import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/stripe.js", async () => {
  const { stripeStub } = await import("../mocks/stripeStub.js");
  return { stripe: stripeStub };
});

const { stripeStub, resetStripeStub, errorConexionStripe, errorServidorStripe } = await import("../mocks/stripeStub.js");
const { app } = await import("../../src/app.js");
const { limpiarBD, crearUsuario, crearPaquete, crearCompra } = await import("../helpers/db.js");
const { generarToken } = await import("../helpers/jwt.js");

describe("GET /api/pagos/compras/:compraId/estado-en-vivo", () => {
  beforeEach(async () => {
    await limpiarBD();
    resetStripeStub();
  });

  it("compraId inexistente responde 404", async () => {
    const usuarioId = await crearUsuario();
    const token = generarToken({ sub: usuarioId });
    const res = await request(app).get(`/api/pagos/compras/${randomUUID()}/estado-en-vivo`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("compraId de otro usuario responde 403, no 404 (no debe filtrar existencia via status distinto)", async () => {
    const duenoId = await crearUsuario();
    const otroId = await crearUsuario();
    const paquete = await crearPaquete();
    const compra = await crearCompra({ usuarioId: duenoId, paqueteId: paquete.id, estado: "pagada" });

    const token = generarToken({ sub: otroId });
    const res = await request(app).get(`/api/pagos/compras/${compra.id}/estado-en-vivo`).set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(stripeStub.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  it("compra sin stripePaymentIntentId responde estadoStripe=sin_intento sin llamar a Stripe", async () => {
    const usuarioId = await crearUsuario();
    const paquete = await crearPaquete();
    const compra = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pendiente", stripePaymentIntentId: null });

    const token = generarToken({ sub: usuarioId });
    const res = await request(app).get(`/api/pagos/compras/${compra.id}/estado-en-vivo`).set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.estadoStripe).toBe("sin_intento");
    expect(stripeStub.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  it("stripe.paymentIntents.retrieve exitoso devuelve el estado y el ultimo error de pago si existe", async () => {
    const usuarioId = await crearUsuario();
    const paquete = await crearPaquete();
    const compra = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pendiente", stripePaymentIntentId: "pi_1" });
    stripeStub.paymentIntents.retrieve.mockResolvedValueOnce({
      status: "requires_payment_method",
      last_payment_error: { code: "card_declined", message: "Tu tarjeta fue rechazada" },
    });

    const token = generarToken({ sub: usuarioId });
    const res = await request(app).get(`/api/pagos/compras/${compra.id}/estado-en-vivo`).set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.estadoStripe).toBe("requires_payment_method");
    expect(res.body.ultimoError).toEqual({ codigo: "card_declined", mensaje: "Tu tarjeta fue rechazada" });
  });

  it("stripe.paymentIntents.retrieve con fallo de red responde 502 origen=stripe_network_error", async () => {
    const usuarioId = await crearUsuario();
    const paquete = await crearPaquete();
    const compra = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pendiente", stripePaymentIntentId: "pi_1" });
    stripeStub.paymentIntents.retrieve.mockRejectedValueOnce(errorConexionStripe());

    const token = generarToken({ sub: usuarioId });
    const res = await request(app).get(`/api/pagos/compras/${compra.id}/estado-en-vivo`).set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(502);
    expect(res.body.origen).toBe("stripe_network_error");
  });

  it("stripe.paymentIntents.retrieve con 5xx responde 502 origen=stripe_server_error", async () => {
    const usuarioId = await crearUsuario();
    const paquete = await crearPaquete();
    const compra = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pendiente", stripePaymentIntentId: "pi_invalido" });
    stripeStub.paymentIntents.retrieve.mockRejectedValueOnce(errorServidorStripe(500));

    const token = generarToken({ sub: usuarioId });
    const res = await request(app).get(`/api/pagos/compras/${compra.id}/estado-en-vivo`).set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(502);
    expect(res.body.origen).toBe("stripe_server_error");
  });
});
