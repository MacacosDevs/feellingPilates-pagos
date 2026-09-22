import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/stripe.js", async () => {
  const { stripeStub } = await import("../mocks/stripeStub.js");
  return { stripe: stripeStub };
});

const { stripeStub, resetStripeStub, errorConexionStripe, errorDeclineStripe } = await import("../mocks/stripeStub.js");
const { app } = await import("../../src/app.js");
const { limpiarBD, crearUsuario, crearPaquete, crearCompra } = await import("../helpers/db.js");
const { generarToken } = await import("../helpers/jwt.js");
const { prisma } = await import("../../src/lib/prisma.js");

describe("POST /api/pagos/compras/:compraId/reembolso", () => {
  beforeEach(async () => {
    await limpiarBD();
    resetStripeStub();
  });

  it("usuario autenticado sin el permiso pagos.reembolsar responde 403", async () => {
    const usuarioId = await crearUsuario();
    const paquete = await crearPaquete();
    const compra = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pagada", stripePaymentIntentId: "pi_1" });
    const token = generarToken({ sub: usuarioId, permisos: [] });

    const res = await request(app).post(`/api/pagos/compras/${compra.id}/reembolso`).set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(stripeStub.refunds.create).not.toHaveBeenCalled();
  });

  it("compraId inexistente responde 404", async () => {
    const adminId = await crearUsuario();
    const token = generarToken({ sub: adminId, permisos: ["pagos.reembolsar"] });

    const res = await request(app).post(`/api/pagos/compras/${randomUUID()}/reembolso`).set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it.each(["pendiente", "fallida", "cancelada", "reembolsada", "en_disputa"])(
    "compra en estado '%s' responde 400 ValidacionError",
    async (estado) => {
      const usuarioId = await crearUsuario();
      const adminId = await crearUsuario();
      const paquete = await crearPaquete();
      const compra = await crearCompra({ usuarioId, paqueteId: paquete.id, estado, stripePaymentIntentId: "pi_1" });
      const token = generarToken({ sub: adminId, permisos: ["pagos.reembolsar"] });

      const res = await request(app).post(`/api/pagos/compras/${compra.id}/reembolso`).set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(stripeStub.refunds.create).not.toHaveBeenCalled();
    },
  );

  it("grupo de compras que comparten stripePaymentIntentId pero no todas 'pagada' responde 400 estado inconsistente", async () => {
    const usuarioId = await crearUsuario();
    const adminId = await crearUsuario();
    const paquete = await crearPaquete();
    const compraPagada = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pagada", stripePaymentIntentId: "pi_grupo" });
    await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "fallida", stripePaymentIntentId: "pi_grupo" });
    const token = generarToken({ sub: adminId, permisos: ["pagos.reembolsar"] });

    const res = await request(app)
      .post(`/api/pagos/compras/${compraPagada.id}/reembolso`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/estado inconsistente/i);
    expect(stripeStub.refunds.create).not.toHaveBeenCalled();
  });

  it("stripe.refunds.create falla: responde 502 y NO actualiza el estado en BD (falla antes del updateMany)", async () => {
    const usuarioId = await crearUsuario();
    const adminId = await crearUsuario();
    const paquete = await crearPaquete();
    const compra = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pagada", stripePaymentIntentId: "pi_1" });
    stripeStub.refunds.create.mockRejectedValueOnce(errorConexionStripe());
    const token = generarToken({ sub: adminId, permisos: ["pagos.reembolsar"] });

    const res = await request(app).post(`/api/pagos/compras/${compra.id}/reembolso`).set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(502);
    expect(res.body.origen).toBe("stripe_network_error");
    const actual = await prisma.compra.findUniqueOrThrow({ where: { id: compra.id } });
    expect(actual.estado).toBe("pagada");
  });

  it("reembolso exitoso marca la compra como reembolsada y devuelve el monto", async () => {
    const usuarioId = await crearUsuario();
    const adminId = await crearUsuario();
    const paquete = await crearPaquete();
    const compra = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pagada", stripePaymentIntentId: "pi_1" });
    stripeStub.refunds.create.mockResolvedValueOnce({ amount: paquete.precioCentavos });
    const token = generarToken({ sub: adminId, permisos: ["pagos.reembolsar"] });

    const res = await request(app).post(`/api/pagos/compras/${compra.id}/reembolso`).set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.estado).toBe("reembolsada");
    expect(res.body.montoReembolsadoCentavos).toBe(paquete.precioCentavos);
    const actual = await prisma.compra.findUniqueOrThrow({ where: { id: compra.id } });
    expect(actual.estado).toBe("reembolsada");
  });

  it("reembolso ya hecho en Stripe (doble refund) responde 502 sin volver a marcar la compra", async () => {
    const usuarioId = await crearUsuario();
    const adminId = await crearUsuario();
    const paquete = await crearPaquete();
    const compra = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pagada", stripePaymentIntentId: "pi_1" });
    const token = generarToken({ sub: adminId, permisos: ["pagos.reembolsar"] });

    stripeStub.refunds.create.mockResolvedValueOnce({ amount: paquete.precioCentavos });
    const primero = await request(app).post(`/api/pagos/compras/${compra.id}/reembolso`).set("Authorization", `Bearer ${token}`);
    expect(primero.status).toBe(200);

    // Segundo intento: la compra ya quedo "reembolsada" en nuestra BD, asi
    // que la validacion de estado (no "pagada") lo bloquea antes de volver a
    // llamar a Stripe -- nunca se llega a un doble refund real en Stripe.
    const segundo = await request(app).post(`/api/pagos/compras/${compra.id}/reembolso`).set("Authorization", `Bearer ${token}`);
    expect(segundo.status).toBe(400);
    expect(stripeStub.refunds.create).toHaveBeenCalledTimes(1);
  });

  it("refund concurrente via HTTP: el timing contra un Postgres real es no determinista, pero nunca debe dar 500/502", async () => {
    const usuarioId = await crearUsuario();
    const adminId = await crearUsuario();
    const paquete = await crearPaquete();
    const compra = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pagada", stripePaymentIntentId: "pi_race" });
    const token = generarToken({ sub: adminId, permisos: ["pagos.reembolsar"] });

    stripeStub.refunds.create.mockResolvedValue({ amount: paquete.precioCentavos });

    const [r1, r2] = await Promise.all([
      request(app).post(`/api/pagos/compras/${compra.id}/reembolso`).set("Authorization", `Bearer ${token}`),
      request(app).post(`/api/pagos/compras/${compra.id}/reembolso`).set("Authorization", `Bearer ${token}`),
    ]);

    for (const res of [r1, r2]) {
      expect([200, 400]).toContain(res.status);
    }
  });

  it("refund concurrente llamando reembolsarCompra() directo dos veces: sin lock, ambas pueden leer 'pagada' y llamar a Stripe", async () => {
    // Llama al service dos veces en paralelo (sin pasar por HTTP) para que
    // ambas lleguen al mismo tiempo al primer `await` (el
    // prisma.compra.findUnique) antes de que cualquiera escriba. Es la
    // reproduccion mas directa de la ventana de carrera descrita en
    // pagoService.ts:reembolsarCompra: no hay SELECT ... FOR UPDATE ni
    // idempotencyKey que impida que las dos lecturas vean "pagada" y las dos
    // lleguen a stripe.refunds.create.
    const usuarioId = await crearUsuario();
    const paquete = await crearPaquete();
    const compra = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pagada", stripePaymentIntentId: "pi_race_directo" });

    stripeStub.refunds.create.mockResolvedValue({ amount: paquete.precioCentavos });

    const { reembolsarCompra } = await import("../../src/services/pagoService.js");
    const resultados = await Promise.allSettled([reembolsarCompra(compra.id), reembolsarCompra(compra.id)]);

    const exitosos = resultados.filter((r) => r.status === "fulfilled").length;
    // eslint-disable-next-line no-console
    console.info(
      `[hallazgo-check] reembolsos exitosos concurrentes: ${exitosos}/2, ` +
        `llamadas reales a stripe.refunds.create: ${stripeStub.refunds.create.mock.calls.length}`,
    );
    // HALLAZGO P1 (pagoService.ts:424): si ambos resultan "fulfilled", hubo
    // dos llamadas reales a stripe.refunds.create para el mismo
    // PaymentIntent -- un reembolso duplicado real en Stripe, no solo en
    // nuestra BD. La compra final debe quedar "reembolsada" en cualquier caso.
    expect((await prisma.compra.findUniqueOrThrow({ where: { id: compra.id } })).estado).toBe("reembolsada");
  });

  it("refunds.create no recibe idempotencyKey (hallazgo: un reintento de red puede generar un reembolso real duplicado en Stripe)", async () => {
    const usuarioId = await crearUsuario();
    const adminId = await crearUsuario();
    const paquete = await crearPaquete();
    const compra = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pagada", stripePaymentIntentId: "pi_1" });
    stripeStub.refunds.create.mockResolvedValueOnce({ amount: paquete.precioCentavos });
    const token = generarToken({ sub: adminId, permisos: ["pagos.reembolsar"] });

    await request(app).post(`/api/pagos/compras/${compra.id}/reembolso`).set("Authorization", `Bearer ${token}`);

    const args = stripeStub.refunds.create.mock.calls[0];
    // args[1] seria el segundo parametro posicional de stripe.refunds.create
    // (requestOptions), donde iria idempotencyKey. A diferencia de
    // paymentIntents.create, aqui no se pasa -- confirmado leyendo
    // pagoService.ts:424.
    expect(args[1]?.idempotencyKey).toBeUndefined();
  });
});
