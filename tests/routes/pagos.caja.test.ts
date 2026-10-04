import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/stripe.js", async () => {
  const { stripeStub } = await import("../mocks/stripeStub.js");
  return { stripe: stripeStub };
});

const { stripeStub, resetStripeStub } = await import("../mocks/stripeStub.js");
const { app } = await import("../../src/app.js");
const { prisma } = await import("../../src/lib/prisma.js");
const { limpiarBD, crearUsuario, crearPaquete, crearCompra } = await import("../helpers/db.js");
const { generarToken } = await import("../helpers/jwt.js");

// Columnas de venta en caja (Flyway V23-V27 del backend Java) mudadas al
// schema "pagos": paquetes sin categoria compuestos por actividad, y compras
// en efectivo/transferencia sin PaymentIntent.

async function crearTipoActividad(): Promise<string> {
  const id = randomUUID();
  await prisma.$executeRawUnsafe(`INSERT INTO public.tipo_actividad (id) VALUES ($1::uuid)`, id);
  return id;
}

describe("columnas de caja", () => {
  beforeEach(async () => {
    await limpiarBD();
    resetStripeStub();
  });

  it("el catalogo publico incluye paquetes sin categoria con su composicion por actividad", async () => {
    const reformer = await crearTipoActividad();
    const mat = await crearTipoActividad();
    const paquete = await crearPaquete({ categoria: null, nombre: "Mixto 6" });
    await prisma.paqueteActividad.createMany({
      data: [
        { paqueteId: paquete.id, tipoActividadId: reformer, cantidadClases: 4 },
        { paqueteId: paquete.id, tipoActividadId: mat, cantidadClases: 2 },
      ],
    });

    const res = await request(app).get("/api/publico/paquetes");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].categoria).toBeNull();
    expect(res.body[0].actividades).toEqual(
      expect.arrayContaining([
        { tipoActividadId: reformer, cantidadClases: 4 },
        { tipoActividadId: mat, cantidadClases: 2 },
      ]),
    );
  });

  it("mis-compras expone el metodo de pago y tolera paquetes sin categoria", async () => {
    const usuarioId = await crearUsuario();
    const paquete = await crearPaquete({ categoria: null });
    await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pagada", metodoPago: "efectivo" });
    const token = generarToken({ sub: usuarioId });

    const res = await request(app).get("/api/pagos/mis-compras").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ categoria: null, metodoPago: "efectivo" });
  });

  it("reembolsar una venta de caja responde 400 sin llamar a Stripe ni tocar otras ventas de caja", async () => {
    const adminId = await crearUsuario();
    const clienteId = await crearUsuario();
    const paquete = await crearPaquete();
    const venta = await crearCompra({ usuarioId: clienteId, paqueteId: paquete.id, estado: "pagada", metodoPago: "efectivo" });
    const otraVenta = await crearCompra({ usuarioId: clienteId, paqueteId: paquete.id, estado: "pagada", metodoPago: "transferencia" });
    const token = generarToken({ sub: adminId, permisos: ["pagos.reembolsar"] });

    const res = await request(app)
      .post(`/api/pagos/compras/${venta.id}/reembolso`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(stripeStub.refunds.create).not.toHaveBeenCalled();
    const estados = await prisma.compra.findMany({ where: { id: { in: [venta.id, otraVenta.id] } } });
    expect(estados.every((c) => c.estado === "pagada")).toBe(true);
  });

  it("pagar un paquete sin categoria no apila sobre otra compra vigente: la vigencia arranca hoy", async () => {
    const usuarioId = await crearUsuario();
    const otro = await crearPaquete({ categoria: null });
    await crearCompra({
      usuarioId,
      paqueteId: otro.id,
      estado: "pagada",
      fechaExpiracion: new Date(Date.now() + 20 * 86_400_000),
    });
    const paquete = await crearPaquete({ categoria: null, vigenciaDias: 30 });
    const compra = await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pendiente", stripePaymentIntentId: "pi_caja" });
    stripeStub.charges.retrieve.mockResolvedValueOnce({ balance_transaction: null });
    const evt = { id: "evt_1", type: "payment_intent.succeeded", data: { object: { id: "pi_caja", latest_charge: "ch_1" } } };
    stripeStub.webhooks.constructEvent.mockReturnValueOnce(evt);

    const antes = Date.now();
    const res = await request(app)
      .post("/api/pagos/webhook")
      .set("Content-Type", "application/json")
      .set("Stripe-Signature", "t=1,v1=firma-de-prueba")
      .send(JSON.stringify(evt));

    expect(res.status).toBe(200);
    const pagada = await prisma.compra.findUniqueOrThrow({ where: { id: compra.id } });
    expect(pagada.estado).toBe("pagada");
    const dias = (pagada.fechaExpiracion!.getTime() - antes) / 86_400_000;
    expect(dias).toBeGreaterThan(29.9);
    expect(dias).toBeLessThan(30.1);
  });
});
