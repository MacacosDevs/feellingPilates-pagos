-- Migracion de corte: mueve paquete/compra del schema "public" (donde las creo
-- Flyway en el monolito Java) al schema "pagos" de este servicio, preservando
-- los datos existentes. Se ejecuta UNA sola vez, coordinada con el deploy que
-- retira el paquete `pagos` del backend Java (ver PagoService/PagoController/
-- PaqueteController alla). No corre sola con `prisma migrate deploy` en un
-- entorno nuevo: en un entorno nuevo, usa CREATE TABLE normal (mas abajo).

CREATE SCHEMA IF NOT EXISTS pagos;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'paquete') THEN
        ALTER TABLE public.paquete SET SCHEMA pagos;
        ALTER TABLE public.compra SET SCHEMA pagos;
    ELSE
        CREATE TABLE pagos.paquete (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            categoria       VARCHAR(20) NOT NULL,
            nombre          VARCHAR(100) NOT NULL,
            descripcion     VARCHAR(255),
            precio_centavos INTEGER NOT NULL,
            vigencia_dias   INTEGER NOT NULL,
            unitario_texto  VARCHAR(50),
            destacado       BOOLEAN NOT NULL DEFAULT false,
            activo          BOOLEAN NOT NULL DEFAULT true,
            orden           INTEGER NOT NULL DEFAULT 0,
            creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
            actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE pagos.compra (
            id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            usuario_id               UUID NOT NULL,
            paquete_id               UUID NOT NULL REFERENCES pagos.paquete (id),
            monto_centavos           INTEGER NOT NULL,
            moneda                   VARCHAR(3) NOT NULL DEFAULT 'mxn',
            estado                   VARCHAR(20) NOT NULL DEFAULT 'pendiente',
            stripe_payment_intent_id VARCHAR(100),
            idempotency_key          VARCHAR(100),
            fecha_expiracion         TIMESTAMPTZ,
            creado_en                TIMESTAMPTZ NOT NULL DEFAULT now(),
            actualizado_en           TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE INDEX idx_compra_usuario ON pagos.compra (usuario_id);
        CREATE INDEX idx_compra_stripe_payment_intent_id ON pagos.compra (stripe_payment_intent_id);
        CREATE INDEX idx_compra_idempotency_key ON pagos.compra (idempotency_key);
    END IF;
END $$;

-- FK cross-schema hacia el usuario dueno de la compra. Postgres lo permite
-- porque sigue siendo la misma base de datos, solo otro namespace.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'compra_usuario_id_fkey'
    ) THEN
        ALTER TABLE pagos.compra
            ADD CONSTRAINT compra_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.usuario (id);
    END IF;
END $$;
