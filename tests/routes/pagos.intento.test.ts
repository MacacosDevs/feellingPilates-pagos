import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/stripe.js", async () => {
  const { stripeStub } = await import("../mocks/stripeStub.js");
  return { stripe: stripeStub };
});

const { stripeStub, resetStripeStub, errorConexionStripe, errorServidorStripe, errorDeclineStripe } = await import(
  "../mocks/stripeStub.js"
);
const { app } = await import("../../src/app.js");
const { limpiarBD, crearUsuario, crearPaquete } = await import("../helpers/db.js");
const { generarToken, generarTokenExpirado } = await import("../helpers/jwt.js");

describe("POST /api/pagos/paquetes/intento", () => {
  beforeEach(async () => {
    await limpiarBD();
    resetStripeStub();
  });

  it("sin Authorization responde 401 y no llega al service", async () => {
    const res = await request(app).post("/api/pagos/paquetes/intento").send({ paqueteIds: ["x"] });
    expect(res.status).toBe(401);
    expect(stripeStub.paymentIntents.create).not.toHaveBeenCalled();
  });

  it("token firmado con otro secreto responde 401", async () => {
    const token = generarToken({ secreto: "otro-secreto-completamente-distinto-32bytes" });
    const res = await request(app)
      .post("/api/pagos/paquetes/intento")
      .set("Authorization", `Bearer ${token}`)
      .send({ paqueteIds: ["x"] });
    expect(res.status).toBe(401);
  });

  it("token expirado responde 401", async () => {
    const token = generarTokenExpirado();
    const res = await request(app)
      .post("/api/pagos/paquetes/intento")
      .set("Authorization", `Bearer ${token}`)
      .send({ paqueteIds: ["x"] });
    expect(res.status).toBe(401);
  });

  it("token con formato invalido (no un JWT) responde 401", async () => {
    const res = await request(app)
      .post("/api/pagos/paquetes/intento")
      .set("Authorization", "Bearer esto-no-es-un-jwt")
      .send({ paqueteIds: ["x"] });
    expect(res.status).toBe(401);
  });

  it("paqueteIds vacio responde 400 ValidacionError", async () => {
    const usuarioId = await crearUsuario();
    const token = generarToken({ sub: usuarioId });
    const res = await request(app)
      .post("/api/pagos/paquetes/intento")
      .set("Authorization", `Bearer ${token}`)
      .send({ paqueteIds: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/al menos un paquete/i);
  });

  it("paqueteIds ausente responde 400 ValidacionError", async () => {
    const usuarioId = await crearUsuario();
    const token = generarToken({ sub: usuarioId });
    const res = await request(app).post("/api/pagos/paquetes/intento").set("Authorization", `Bearer ${token}`).send({});
    expect(res.status).toBe(400);
  });

  it("paqueteId inexistente responde 404 RecursoNoEncontradoError", async () => {
    const usuarioId = await crearUsuario();
    const token = generarToken({ sub: usuarioId });
    const res = await request(app)
      .post("/api/pagos/paquetes/intento")
      .set("Authorization", `Bearer ${token}`)
      .send({ paqueteIds: [randomUUID()] });
    expect(res.status).toBe(404);
  });

  it("paqueteId de un paquete activo=false responde 404", async () => {
    const usuarioId = await crearUsuario();
    const paquete = await crearPaquete({ activo: false });
    const token = generarToken({ sub: usuarioId });
    const res = await request(app)
      .post("/api/pagos/paquetes/intento")
      .set("Authorization", `Bearer ${token}`)
      .send({ paqueteIds: [paquete.id] });
    expect(res.status).toBe(404);
  });

  it("paqueteIds con duplicados (mismo id dos veces) responde 404 por el chequeo de tamano de set", async () => {
    // paquetes.length (1, porque el findMany deduplica por id) !== new
    // Set(paqueteIds).size (1)... en realidad con un solo id repetido,
    // paquetes.length=1 y el Set.size=1, son iguales: no dispara el error.
    // Documentamos el comportamiento real: se cobra el paquete una sola vez,
    // no dos, pese a pedirlo dos veces (ver MATRIZ-COBERTURA.md, hallazgo).
    const usuarioId = await crearUsuario();
    const paquete = await crearPaquete();
    const token = generarToken({ sub: usuarioId });
    stripeStub.paymentIntents.create.mockResolvedValue({
      id: "pi_dup",
      client_secret: "secret_dup",
    });

    const res = await request(app)
      .post("/api/pagos/paquetes/intento")
      .set("Authorization", `Bearer ${token}`)
      .send({ paqueteIds: [paquete.id, paquete.id] });

    expect(res.status).toBe(200);
    // Se crearon 2 Compra (una por cada entrada de paqueteIds), pero por un
    // solo monto de paquete: si el monto total facturado a Stripe cuenta el
    // paquete dos veces, es un doble cobro real. Confirmamos aqui cuantas
    // Compra resultan y dejamos la severidad en la matriz.
    expect(res.body.compraIds).toHaveLength(2);
    expect(stripeStub.paymentIntents.create).toHaveBeenCalledTimes(1);
    const args = stripeStub.paymentIntents.create.mock.calls[0][0];
    expect(args.amount).toBe(paquete.precioCentavos * 2);
  });

  it("reintento con el mismo idempotencyKey reusa el PaymentIntent existente sin crear uno nuevo", async () => {
    const usuarioId = await crearUsuario();
    const paquete = await crearPaquete();
    const token = generarToken({ sub: usuarioId });
    const idempotencyKey = randomUUID();

    stripeStub.paymentIntents.create.mockResolvedValueOnce({ id: "pi_original", client_secret: "secret_original" });

    const primera = await request(app)
      .post("/api/pagos/paquetes/intento")
      .set("Authorization", `Bearer ${token}`)
      .send({ paqueteIds: [paquete.id], idempotencyKey });
    expect(primera.status).toBe(200);
    expect(primera.body.clientSecret).toBe("secret_original");

    stripeStub.paymentIntents.retrieve.mockResolvedValueOnce({ id: "pi_original", client_secret: "secret_original" });

    const segunda = await request(app)
      .post("/api/pagos/paquetes/intento")
      .set("Authorization", `Bearer ${token}`)
      .send({ paqueteIds: [paquete.id], idempotencyKey });

    expect(segunda.status).toBe(200);
    expect(segunda.body.clientSecret).toBe("secret_original");
    expect(segunda.body.compraIds).toEqual(primera.body.compraIds);
    expect(stripeStub.paymentIntents.create).toHaveBeenCalledTimes(1);
    expect(stripeStub.paymentIntents.retrieve).toHaveBeenCalledTimes(1);
  });

  it("dos requests simultaneos con la misma idempotencyKey: ambas terminan en 200 con el mismo clientSecret (P1-1 corregido)", async () => {
    // Contra un Postgres real (Testcontainers), la request perdedora de la
    // carrera ahora espera brevemente (esperarAsignacionDeIntent) en vez de
    // fallar de inmediato -- ver el fix en reusarSiExiste.
    const usuarioId = await crearUsuario();
    const paquete = await crearPaquete();
    const token = generarToken({ sub: usuarioId });
    const idempotencyKey = randomUUID();

    let intentCreado: { id: string; client_secret: string } | null = null;
    stripeStub.paymentIntents.create.mockImplementation(async () => {
      if (!intentCreado) {
        intentCreado = { id: "pi_concurrente", client_secret: "secret_concurrente" };
      }
      return intentCreado;
    });
    stripeStub.paymentIntents.retrieve.mockImplementation(async () => intentCreado);

    const [r1, r2] = await Promise.all([
      request(app)
        .post("/api/pagos/paquetes/intento")
        .set("Authorization", `Bearer ${token}`)
        .send({ paqueteIds: [paquete.id], idempotencyKey }),
      request(app)
        .post("/api/pagos/paquetes/intento")
        .set("Authorization", `Bearer ${token}`)
        .send({ paqueteIds: [paquete.id], idempotencyKey }),
    ]);

    for (const res of [r1, r2]) {
      expect(res.status).toBe(200);
      expect(res.body.clientSecret).toBe("secret_concurrente");
    }
    // Un solo PaymentIntent real creado, sin importar cual request "gano".
    expect(stripeStub.paymentIntents.create).toHaveBeenCalledTimes(1);
  });

  it("reusarSiExiste sobre una Compra a medio crear: si el intent se asigna poco despues, espera y lo reusa en vez de fallar", async () => {
    // Reproduce de forma deterministica el estado exacto en el que queda la
    // BD a mitad de crearIntentoPago: el paso 1 (crear las filas Compra con
    // idempotencyKey) ya se ejecuto, pero el paso 2 (llamar a Stripe y
    // guardar stripePaymentIntentId via updateMany) todavia no. Simula que
    // la request ganadora termina un instante despues (dentro de la ventana
    // de espera configurada, ver tests/setup/testEnv.ts).
    const usuarioId = await crearUsuario();
    const paquete = await crearPaquete();
    const token = generarToken({ sub: usuarioId });
    const idempotencyKey = randomUUID();

    const { crearCompra } = await import("../helpers/db.js");
    const { prisma } = await import("../../src/lib/prisma.js");
    const compra = await crearCompra({ usuarioId, paqueteId: paquete.id, idempotencyKey, stripePaymentIntentId: null });

    setTimeout(() => {
      prisma.compra.update({ where: { id: compra.id }, data: { stripePaymentIntentId: "pi_tardio" } }).catch(() => {});
    }, 40);
    stripeStub.paymentIntents.retrieve.mockResolvedValueOnce({ id: "pi_tardio", client_secret: "secret_tardio" });

    const res = await request(app)
      .post("/api/pagos/paquetes/intento")
      .set("Authorization", `Bearer ${token}`)
      .send({ paqueteIds: [paquete.id], idempotencyKey });

    expect(res.status).toBe(200);
    expect(res.body.clientSecret).toBe("secret_tardio");
    expect(res.body.compraIds).toEqual([compra.id]);
    expect(stripeStub.paymentIntents.create).not.toHaveBeenCalled();
  });

  it("reusarSiExiste sobre una Compra que nunca llega a tener intent: responde 502 origen=internal_error, sin llamar a Stripe con un id nulo", async () => {
    // La request original que creo estas filas Compra nunca termino (se
    // cayo, crasheo) -- el intent nunca se asigna. Tras agotar la ventana de
    // espera, se debe fallar de forma clara y segura, no colgarse ni pasarle
    // null a stripe.paymentIntents.retrieve.
    const usuarioId = await crearUsuario();
    const paquete = await crearPaquete();
    const token = generarToken({ sub: usuarioId });
    const idempotencyKey = randomUUID();

    const { crearCompra } = await import("../helpers/db.js");
    await crearCompra({ usuarioId, paqueteId: paquete.id, idempotencyKey, stripePaymentIntentId: null });

    const res = await request(app)
      .post("/api/pagos/paquetes/intento")
      .set("Authorization", `Bearer ${token}`)
      .send({ paqueteIds: [paquete.id], idempotencyKey });

    expect(res.status).toBe(502);
    expect(res.body.origen).toBe("internal_error");
    expect(stripeStub.paymentIntents.retrieve).not.toHaveBeenCalled();
    expect(stripeStub.paymentIntents.create).not.toHaveBeenCalled();
  });

  it("reusarSiExiste: si stripe.paymentIntents.retrieve falla, traduce el error con traducirErrorStripe", async () => {
    const usuarioId = await crearUsuario();
    const paquete = await crearPaquete();
    const token = generarToken({ sub: usuarioId });
    const idempotencyKey = randomUUID();

    stripeStub.paymentIntents.create.mockResolvedValueOnce({ id: "pi_1", client_secret: "secret_1" });
    await request(app)
      .post("/api/pagos/paquetes/intento")
      .set("Authorization", `Bearer ${token}`)
      .send({ paqueteIds: [paquete.id], idempotencyKey });

    stripeStub.paymentIntents.retrieve.mockRejectedValueOnce(errorConexionStripe());

    const res = await request(app)
      .post("/api/pagos/paquetes/intento")
      .set("Authorization", `Bearer ${token}`)
      .send({ paqueteIds: [paquete.id], idempotencyKey });

    expect(res.status).toBe(502);
    expect(res.body.origen).toBe("stripe_network_error");
  });

  it("stripe.paymentIntents.create con StripeConnectionError responde 502 origen=stripe_network_error", async () => {
    const usuarioId = await crearUsuario();
    const paquete = await crearPaquete();
    const token = generarToken({ sub: usuarioId });
    stripeStub.paymentIntents.create.mockRejectedValueOnce(errorConexionStripe());

    const res = await request(app)
      .post("/api/pagos/paquetes/intento")
      .set("Authorization", `Bearer ${token}`)
      .send({ paqueteIds: [paquete.id] });

    expect(res.status).toBe(502);
    expect(res.body.origen).toBe("stripe_network_error");
  });

  it("stripe.paymentIntents.create con statusCode >= 500 responde 502 origen=stripe_server_error", async () => {
    const usuarioId = await crearUsuario();
    const paquete = await crearPaquete();
    const token = generarToken({ sub: usuarioId });
    stripeStub.paymentIntents.create.mockRejectedValueOnce(errorServidorStripe(503));

    const res = await request(app)
      .post("/api/pagos/paquetes/intento")
      .set("Authorization", `Bearer ${token}`)
      .send({ paqueteIds: [paquete.id] });

    expect(res.status).toBe(502);
    expect(res.body.origen).toBe("stripe_server_error");
  });

  it("stripe.paymentIntents.create con decline 4xx responde 502 origen=stripe_decline", async () => {
    const usuarioId = await crearUsuario();
    const paquete = await crearPaquete();
    const token = generarToken({ sub: usuarioId });
    stripeStub.paymentIntents.create.mockRejectedValueOnce(errorDeclineStripe());

    const res = await request(app)
      .post("/api/pagos/paquetes/intento")
      .set("Authorization", `Bearer ${token}`)
      .send({ paqueteIds: [paquete.id] });

    expect(res.status).toBe(502);
    expect(res.body.origen).toBe("stripe_decline");
  });
});
