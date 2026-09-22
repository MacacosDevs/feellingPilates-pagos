import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/stripe.js", async () => {
  const { stripeStub } = await import("../mocks/stripeStub.js");
  return { stripe: stripeStub };
});

const { stripeStub, resetStripeStub } = await import("../mocks/stripeStub.js");
const { reconciliarComprasPendientes } = await import("../../src/services/pagoService.js");
const { limpiarBD, crearUsuario, crearPaquete, crearCompra } = await import("../helpers/db.js");
const { prisma } = await import("../../src/lib/prisma.js");

describe("reconciliarComprasPendientes (job de reconciliacion)", () => {
  beforeEach(async () => {
    await limpiarBD();
    resetStripeStub();
  });

  it("compra pendiente sin stripePaymentIntentId se ignora (no llama a Stripe)", async () => {
    const usuarioId = await crearUsuario();
    const paquete = await crearPaquete();
    await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pendiente", stripePaymentIntentId: null });

    await reconciliarComprasPendientes();

    expect(stripeStub.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  it("si stripe.paymentIntents.retrieve falla para una compra, loguea y sigue con las demas del batch", async () => {
    const usuarioId = await crearUsuario();
    const paquete = await crearPaquete();
    const compraFalla = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pendiente", stripePaymentIntentId: "pi_falla" });
    const compraOk = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pendiente", stripePaymentIntentId: "pi_ok" });

    stripeStub.paymentIntents.retrieve.mockImplementation(async (id: string) => {
      if (id === "pi_falla") {
        throw new Error("network error");
      }
      return { status: "canceled", latest_charge: null };
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(reconciliarComprasPendientes()).resolves.toBeUndefined();
    warnSpy.mockRestore();

    expect((await prisma.compra.findUniqueOrThrow({ where: { id: compraFalla.id } })).estado).toBe("pendiente");
    expect((await prisma.compra.findUniqueOrThrow({ where: { id: compraOk.id } })).estado).toBe("cancelada");
  });

  it("intent status 'succeeded' aplica pagada igual que el webhook", async () => {
    const usuarioId = await crearUsuario();
    const paquete = await crearPaquete({ vigenciaDias: 30 });
    const compra = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pendiente", stripePaymentIntentId: "pi_1" });

    stripeStub.paymentIntents.retrieve.mockResolvedValueOnce({ status: "succeeded", latest_charge: null });

    await reconciliarComprasPendientes();

    expect((await prisma.compra.findUniqueOrThrow({ where: { id: compra.id } })).estado).toBe("pagada");
  });

  it("intent status 'canceled' marca la compra como cancelada", async () => {
    const usuarioId = await crearUsuario();
    const paquete = await crearPaquete();
    const compra = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pendiente", stripePaymentIntentId: "pi_1" });

    stripeStub.paymentIntents.retrieve.mockResolvedValueOnce({ status: "canceled", latest_charge: null });

    await reconciliarComprasPendientes();

    expect((await prisma.compra.findUniqueOrThrow({ where: { id: compra.id } })).estado).toBe("cancelada");
  });

  it("intent en otro estado pero dentro de la ventana de expiracion no se toca", async () => {
    const usuarioId = await crearUsuario();
    const paquete = await crearPaquete();
    const compra = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pendiente", stripePaymentIntentId: "pi_1" });

    stripeStub.paymentIntents.retrieve.mockResolvedValueOnce({ status: "requires_payment_method", latest_charge: null });

    await reconciliarComprasPendientes();

    expect((await prisma.compra.findUniqueOrThrow({ where: { id: compra.id } })).estado).toBe("pendiente");
  });

  it("intent en otro estado y ya paso el limite de abandono se marca cancelada", async () => {
    // env.compraPendienteExpiraMinutos se lee una sola vez al importar
    // config/env.ts (cacheado en el objeto `env`), asi que reasignar
    // process.env aqui no tendria efecto: en vez de eso, la compra se crea
    // con creadoEn mas atras que COMPRA_PENDIENTE_EXPIRA_MINUTOS (60,
    // fijado en tests/setup/testEnv.ts).
    const usuarioId = await crearUsuario();
    const paquete = await crearPaquete();
    const compra = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pendiente", stripePaymentIntentId: "pi_1" });
    await prisma.compra.update({ where: { id: compra.id }, data: { creadoEn: new Date(Date.now() - 61 * 60_000) } });

    stripeStub.paymentIntents.retrieve.mockResolvedValueOnce({ status: "requires_payment_method", latest_charge: null });

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    await reconciliarComprasPendientes();
    infoSpy.mockRestore();

    expect((await prisma.compra.findUniqueOrThrow({ where: { id: compra.id } })).estado).toBe("cancelada");
  });

  it("webhook y cron casi simultaneos sobre la misma compra no producen estado inconsistente (guard idempotente en aplicarPagada)", async () => {
    const usuarioId = await crearUsuario();
    const paquete = await crearPaquete({ vigenciaDias: 30 });
    const compra = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pendiente", stripePaymentIntentId: "pi_1" });

    stripeStub.paymentIntents.retrieve.mockResolvedValue({ status: "succeeded", latest_charge: null });

    const { procesarWebhook } = await import("../../src/services/pagoService.js");
    // "Casi simultaneos": corremos el ciclo de reconciliacion y el
    // procesamiento del webhook para el mismo intent en paralelo.
    await Promise.all([
      reconciliarComprasPendientes(),
      procesarWebhook({ id: "evt_1", type: "payment_intent.succeeded", data: { object: { id: "pi_1", latest_charge: null } } } as never),
    ]);

    const actual = await prisma.compra.findUniqueOrThrow({ where: { id: compra.id } });
    expect(actual.estado).toBe("pagada");
    // No debe haber quedado en un estado intermedio ni lanzado: una sola
    // fechaExpiracion consistente con el primero que gano la carrera.
    expect(actual.fechaExpiracion).not.toBeNull();
  });
});
