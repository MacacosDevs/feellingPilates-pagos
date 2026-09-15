-- Detalle del Charge de Stripe (marca/ultimos digitos de tarjeta, recibo,
-- comision y monto neto, nivel de riesgo de Radar) y motivo del ultimo
-- rechazo, para no depender solo del Dashboard de Stripe para ver esto.
ALTER TABLE pagos.compra
    ADD COLUMN tarjeta_marca VARCHAR(20),
    ADD COLUMN tarjeta_ultimos_digitos VARCHAR(4),
    ADD COLUMN recibo_url VARCHAR(500),
    ADD COLUMN monto_comision_centavos INTEGER,
    ADD COLUMN monto_neto_centavos INTEGER,
    ADD COLUMN riesgo_nivel VARCHAR(20),
    ADD COLUMN ultimo_error_codigo VARCHAR(100),
    ADD COLUMN ultimo_error_mensaje VARCHAR(500);
