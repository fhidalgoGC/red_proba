# Payloads reales del orquestador

No están escritos a mano: se **capturaron del cable**. Se levantó un servidor
que vuelca el cuerpo crudo, se apuntó el orquestador a él con
`ORQ_CONFIG_DIR`, y se lanzó `POST /batch {"client":"1","seconds":2,"rate":2,
"perRequest":2}`. Lo que hay aquí es exactamente lo que salió.

| Archivo | Qué es |
|---|---|
| `lote-real-2-documentos.json` | El lote tal cual, 4.212 bytes en el cable |
| `lote-real-1-documento.json` | El mismo, recortado a un documento |
| `curl-c3.sh` | El request completo contra `localhost:3001` |

Las cabeceras que acompañaban al cuerpo:

```
content-type: application/json
x-lote-id:    fbf132f5-f21c-4447-81e5-9df6adb9e6fe
x-tenant-id:  tenant-01
x-eventos:    2
x-prueba-id:  captura          <- el id que se le pasó a POST /batch
```

⚠ **`party_id` viene en ceros a propósito.** Es el placeholder de 69
caracteres; C3 lo sustituye por el HMAC-SHA256 real de KMS antes de canonizar.
El largo es fijo justamente para que la sustitución no mueva el tamaño canónico
que el orquestador ya ajustó al byte.

⚠ **Reenviar esto tal cual no es lo que hace el orquestador.** Cada envío
refresca `event_id`, `rpf_id`, `sequence` y `occurred_at` (regla 11): un
documento idéntico da el mismo `payload_hash`, y SQS FIFO lo descarta **en
silencio** durante 5 minutos. Para probar C3 a mano da igual; para medir, no.
