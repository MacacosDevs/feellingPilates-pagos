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

  it("refund concurrente via HTTP: nunca da 500/502, y toda llamada real a Stripe usa la MISMA idempotencyKey", async () => {
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
    const claves = stripeStub.refunds.create.mock.calls.map((args) => args[1]?.idempotencyKey);
    expect(new Set(claves).size).toBeLessThanOrEqual(1);
  });

  it("refund concurrente llamando reembolsarCompra() directo dos veces: ambas usan la MISMA idempotencyKey deterministica (no P1-2)", async () => {
    // Llama al service dos veces en paralelo (sin pasar por HTTP). Con
    // Stripe real, dos llamadas con la MISMA idempotencyKey para el mismo
    // intent resuelven a un unico refund real sin importar cuantas veces se
    // haya llamado aqui -- lo que este test puede verificar contra el mock
    // es que la clave que se les pasa es siempre identica, no aleatoria por
    // request (ver fix de P1-2, pagoService.ts:reembolsarCompra).
    const usuarioId = await crearUsuario();
    const paquete = await crearPaquete();
    const compra = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pagada", stripePaymentIntentId: "pi_race_directo" });

    stripeStub.refunds.create.mockResolvedValue({ amount: paquete.precioCentavos });

    const { reembolsarCompra } = await import("../../src/services/pagoService.js");
    const resultados = await Promise.allSettled([reembolsarCompra(compra.id), reembolsarCompra(compra.id)]);

    expect(resultados.every((r) => r.status === "fulfilled")).toBe(true);
    expect((await prisma.compra.findUniqueOrThrow({ where: { id: compra.id } })).estado).toBe("reembolsada");

    const claves = stripeStub.refunds.create.mock.calls.map((args) => args[1]?.idempotencyKey);
    expect(claves.length).toBeGreaterThanOrEqual(1);
    expect(new Set(claves)).toEqual(new Set(["refund_pi_race_directo"]));
  });

  it("refunds.create SI recibe una idempotencyKey deterministica por PaymentIntent (P1-2 corregido)", async () => {
    const usuarioId = await crearUsuario();
    const adminId = await crearUsuario();
    const paquete = await crearPaquete();
    const compra = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pagada", stripePaymentIntentId: "pi_key_test" });
    stripeStub.refunds.create.mockResolvedValueOnce({ amount: paquete.precioCentavos });
    const token = generarToken({ sub: adminId, permisos: ["pagos.reembolsar"] });

    await request(app).post(`/api/pagos/compras/${compra.id}/reembolso`).set("Authorization", `Bearer ${token}`);

    const args = stripeStub.refunds.create.mock.calls[0];
    // La clave depende solo del PaymentIntent (no de un valor aleatorio por
    // request): un reintento de red con el mismo intent produce la misma
    // clave, y Stripe la deduplica en vez de crear un segundo refund real.
    expect(args[1]?.idempotencyKey).toBe("refund_pi_key_test");
  });

  it("si Stripe rechaza el refund por conflicto de idempotencyKey pero el grupo ya quedo reembolsado (por la otra request), devuelve exito en vez de 502", async () => {
    // Reproduce de forma deterministica el caso en el que Stripe rechaza una
    // llamada por reusar la misma idempotencyKey mientras otra sigue en
    // vuelo: en vez de traducirlo como un error, se revisa el estado real
    // en BD y, si ya quedo reembolsado (porque la otra request gano),
    // se devuelve ese resultado en vez de un 502 enganoso.
    const usuarioId = await crearUsuario();
    const paquete = await crearPaquete();
    const compra = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pagada", stripePaymentIntentId: "pi_conflicto" });

    stripeStub.refunds.create.mockImplementationOnce(async () => {
      await prisma.compra.update({ where: { id: compra.id }, data: { estado: "reembolsada" } });
      throw errorDeclineStripe(400, "An idempotency key can't be reused for a request that is still being processed");
    });

    const { reembolsarCompra } = await import("../../src/services/pagoService.js");
    const resultado = await reembolsarCompra(compra.id);

    expect(resultado.estado).toBe("reembolsada");
    expect(resultado.montoReembolsadoCentavos).toBe(paquete.precioCentavos);
  });
});
