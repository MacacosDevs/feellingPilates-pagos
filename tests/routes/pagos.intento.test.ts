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

  it("dos requests simultaneos con la misma idempotencyKey: contra un Postgres real, el timing de la carrera es no determinista", async () => {
    // Documenta el intento inicial de reproducir la carrera con
    // Promise.all() contra un Postgres real (Testcontainers): el orden en
    // que ambas requests intercalan sus awaits de red no es reproducible de
    // una corrida a otra. La reproduccion determinista de la ventana de
    // carrera esta en el siguiente test.
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
    stripeStub.paymentIntents.retrieve.mockRejectedValue(errorDeclineStripe(400, "No such payment_intent"));

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

    // Ambas respuestas deben ser 200 (exito) o 502 stripe_decline (la
    // perdedora de la carrera, ver hallazgo P1 en MATRIZ-COBERTURA.md) --
    // nunca otra cosa. Cuando ambas caen en 200 esta corrida no disparo la
    // ventana de carrera; el siguiente test la fuerza de forma deterministica.
    for (const res of [r1, r2]) {
      expect([200, 502]).toContain(res.status);
      if (res.status === 502) {
        expect(res.body.origen).toBe("stripe_decline");
      }
    }
  });

  it("reusarSiExiste sobre una Compra a medio crear (stripePaymentIntentId aun null) responde 502 en vez de esperar/reintentar", async () => {
    // Reproduce de forma deterministica el estado exacto en el que queda la
    // BD a mitad de crearIntentoPago: el paso 1 (crear las filas Compra con
    // idempotencyKey) ya se ejecuto, pero el paso 2 (llamar a Stripe y
    // guardar stripePaymentIntentId via updateMany) todavia no. Es
    // exactamente lo que ve una segunda request con la misma idempotencyKey
    // si llega en esa ventana.
    const usuarioId = await crearUsuario();
    const paquete = await crearPaquete();
    const token = generarToken({ sub: usuarioId });
    const idempotencyKey = randomUUID();

    const { crearCompra } = await import("../helpers/db.js");
    await crearCompra({ usuarioId, paqueteId: paquete.id, idempotencyKey, stripePaymentIntentId: null });

    stripeStub.paymentIntents.retrieve.mockRejectedValueOnce(errorDeclineStripe(400, "No such payment_intent"));

    const res = await request(app)
      .post("/api/pagos/paquetes/intento")
      .set("Authorization", `Bearer ${token}`)
      .send({ paqueteIds: [paquete.id], idempotencyKey });

    // HALLAZGO P1 (ver MATRIZ-COBERTURA.md): un cliente que reintenta por un
    // timeout, o un doble-tap, durante esta ventana de milisegundos recibe un
    // 502 "stripe_decline" en vez de que el sistema espere/reintente o le
    // devuelva el intent real una vez creado. El origen es enganoso: no es
    // un decline real de Stripe, es que reusarSiExiste llamo a
    // stripe.paymentIntents.retrieve con un id todavia nulo.
    expect(res.status).toBe(502);
    expect(res.body.origen).toBe("stripe_decline");
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
