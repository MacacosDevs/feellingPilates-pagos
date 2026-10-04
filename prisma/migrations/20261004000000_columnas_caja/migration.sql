-- Columnas de venta en caja (presencial, efectivo/transferencia, sin Stripe)
-- y composicion de paquetes por actividad. Las creo el backend Java en sus
-- migraciones Flyway V23, V25, V26 y V27 sobre public.paquete/public.compra.
--
-- Idempotente a proposito, porque el orden entre Flyway (Java) y esta
-- migracion no es el mismo en todos los ambientes:
--   * Si Flyway V23-V27 corrio ANTES del baseline (las columnas ya viajaron
--     con la tabla al schema "pagos"), aqui no se agrega nada y solo se muda
--     paquete_actividad.
--   * Si el baseline creo las tablas desde cero (no existia public.paquete),
--     aqui se crean las columnas y la tabla.

ALTER TABLE pagos.paquete ALTER COLUMN categoria DROP NOT NULL;

ALTER TABLE pagos.compra
    ADD COLUMN IF NOT EXISTS metodo_pago       VARCHAR(20) NOT NULL DEFAULT 'stripe',
    ADD COLUMN IF NOT EXISTS registrada_por_id UUID,
    ADD COLUMN IF NOT EXISTS salon_id          UUID,
    ADD COLUMN IF NOT EXISTS grupo_compra_id   UUID,
    ADD COLUMN IF NOT EXISTS numero_item       INTEGER,
    ADD COLUMN IF NOT EXISTS motivo_estado     TEXT;

CREATE INDEX IF NOT EXISTS idx_compra_grupo ON pagos.compra (grupo_compra_id);

-- FKs cross-schema hacia tablas del backend principal (mismo criterio que
-- compra_usuario_id_fkey en el baseline). Los nombres coinciden con los que
-- Postgres genero para Flyway, asi no se duplican si ya existen.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compra_registrada_por_id_fkey') THEN
        ALTER TABLE pagos.compra
            ADD CONSTRAINT compra_registrada_por_id_fkey FOREIGN KEY (registrada_por_id) REFERENCES public.usuario (id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compra_salon_id_fkey') THEN
        ALTER TABLE pagos.compra
            ADD CONSTRAINT compra_salon_id_fkey FOREIGN KEY (salon_id) REFERENCES public.salon (id);
    END IF;
END $$;

-- paquete_actividad es parte del catalogo de paquetes: se muda al schema de
-- este servicio junto con paquete. Su FK a public.tipo_actividad se conserva.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'paquete_actividad') THEN
        ALTER TABLE public.paquete_actividad SET SCHEMA pagos;
    ELSIF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'pagos' AND table_name = 'paquete_actividad') THEN
        CREATE TABLE pagos.paquete_actividad (
            id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            paquete_id        UUID NOT NULL REFERENCES pagos.paquete (id) ON DELETE CASCADE,
            tipo_actividad_id UUID NOT NULL REFERENCES public.tipo_actividad (id),
            cantidad_clases   INTEGER NOT NULL,
            creado_en         TIMESTAMPTZ NOT NULL DEFAULT now(),
            actualizado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (paquete_id, tipo_actividad_id)
        );
    END IF;
END $$;
